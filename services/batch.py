"""
Společná kostra dávkového zpracování otázek (podcasty, studijní texty, kartičky).

Kostra řídí stav dávky (`active_batches`), zrušení, 3 pokusy na otázku s čekáním 5/10 s, noční doplňovací
kola, dávkové události pro frontend a bezpodmínečný úklid. Konkrétní režim dodá texty logů (`BatchTexts`)
a funkci `produce`, která otázku zpracuje.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from core.logger import BatchState, active_batches, send_batch_event, send_log
from core.utils import friendly_api_error, is_terminal_auth_error

# produce(batch, title, question_index) -> True = hotovo; False = přerušeno zrušením dávky uprostřed práce
Producer = Callable[[BatchState, Any, Any], Awaitable[bool]]


@dataclass(frozen=True)
class BatchTexts:
    """Šablony logů režimu (str.format). Hodnoty z otázek se dosazují jako argumenty, ne do šablony."""

    started: str  # {questions}
    cancelled_by_user: str
    processing: str  # {idx}, {total}, {title}
    question_done: str  # {idx}, {total}
    question_failed: str  # {title} (prvních 35 znaků), {error}
    sweep_round: str  # {round}, {max_rounds}, {count}
    sweep_retry: str  # {title} (prvních 35 znaků)
    finished_cancelled: str
    finished_completed: str  # {total}
    finished_with_errors: str  # {done}, {total}, {pending}
    aborted: str  # {error}


async def run_question_batch(
    *,
    project: str,
    batch_id: str,
    questions: list,
    mode: str,
    overnight_mode: bool,
    texts: BatchTexts,
    produce: Producer,
    stop_on_auth_error: bool,
) -> None:
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(texts.started.format(questions=len(questions)))
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode=mode,
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log(texts.cancelled_by_user)
                outcome = "cancelled"
                break

            title = question_data.get("title")
            question_index = question_data.get("q_index")
            await send_log(texts.processing.format(idx=idx + 1, total=len(questions), title=title))

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    if not await produce(batch, title, question_index):
                        break
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if stop_on_auth_error and is_terminal_auth_error(err):
                        await send_log(f"🛑 Fatální chyba autorizace: {friendly_api_error(err, 'Gemini')}")
                        batch.cancel_requested = True
                        break
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(
                            f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s..."
                        )
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode=mode,
                    question_index=question_index,
                )
                await send_log(texts.question_done.format(idx=idx + 1, total=len(questions)))
            else:
                await send_log(texts.question_failed.format(title=title[:35], error=str(last_err)))
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode=mode,
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(
                    texts.sweep_round.format(round=sweep_idx, max_rounds=max_sweeps, count=len(failed_questions))
                )
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(texts.sweep_retry.format(title=q_title[:35]))
                    try:
                        # Zrušení uprostřed zpracování ukončí celé kolo (zbylé otázky se už nezkouší)
                        if not await produce(batch, q_title, q_idx):
                            break
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode=mode,
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log(texts.finished_cancelled)
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(texts.finished_completed.format(total=len(questions)))
        else:
            outcome = "completed_with_errors"
            await send_log(
                texts.finished_with_errors.format(
                    done=len(batch.completed_question_indexes),
                    total=len(questions),
                    pending=len(pending_question_indexes),
                )
            )

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(texts.aborted.format(error=failed_message))
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode=mode,
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            # Bezpodmínečný úklid je klíčový: po chybě musí jít dávku ihned
            # znovu spustit, bez restartování backendu.
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]

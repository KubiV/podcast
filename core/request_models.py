"""Základ Pydantic modelů pro JSON těla požadavků (krok 4.10)."""

from pydantic import BaseModel, ConfigDict


class RequestModel(BaseModel):
    """
    Tělo JSON požadavku s typy polí a výchozími hodnotami.

    Strict: hodnota se nikdy nepřevádí (např. "10" na 10), takže handler dostane přesně to, co by vrátil dřívější
    `payload.get(...)`; hodnota jiného typu skončí 422. Pole přijímají i `null` (None) jako dříve u dict
    a neznámé klíče se ignorují.
    """

    model_config = ConfigDict(strict=True, extra="ignore", protected_namespaces=())

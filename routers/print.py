import html as html_lib
import subprocess
import sys
import uuid
import webbrowser
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import HTMLResponse

from core.logger import send_log
from core.utils import sanitize_name

router = APIRouter()

_print_jobs: dict[str, Any] = {}


@router.post("/api/print/prepare")
async def prepare_print_job(request: Request, payload: dict = Body(...)):
    """
    Přijme vygenerovaný HTML obsah a metadata k tisku.
    Uloží data do dočasné mezipaměti a vrátí URL adresu čistého tiskového náhledu.
    Pokud je požadováno (auto_open_browser), otevře odkaz v systémovém prohlížeči.
    """
    doc_id = uuid.uuid4().hex[:10]
    title = str(payload.get("title", "")).strip() or "Studijní dokument"
    html_content = str(payload.get("html", "")).strip()
    project = str(payload.get("project", "")).strip()
    auto_open = bool(payload.get("auto_open_browser", False))
    now_ts = datetime.now().timestamp()

    _print_jobs[doc_id] = {
        "title": title,
        "html": html_content,
        "project": project,
        "created_at": now_ts,
    }

    # Úklid úloh starších než 2 hodiny
    for k in list(_print_jobs.keys()):
        if now_ts - _print_jobs[k].get("created_at", 0) > 7200:
            _print_jobs.pop(k, None)

    base_url = str(request.base_url).rstrip("/")
    full_url = f"{base_url}/print_preview/{doc_id}"

    if auto_open:
        try:
            webbrowser.open(full_url)
        except Exception as e:
            print(f"⚠️ Nepodařilo se automaticky otevřít systémový prohlížeč pro tisk: {e}")

    return {"status": "ok", "doc_id": doc_id, "url": full_url}


@router.get("/print_preview/{doc_id}", response_class=HTMLResponse)
async def view_print_preview_page(doc_id: str):
    job = _print_jobs.get(doc_id)
    if not job:
        raise HTTPException(status_code=404, detail="Tiskový dokument nebyl nalezen nebo vypršela jeho platnost.")

    safe_title = html_lib.escape(job["title"])
    safe_project = html_lib.escape(job["project"] or "Hlavní projekt")
    date_str = datetime.now().strftime("%d.%m.%Y %H:%M")
    rendered_body = job["html"]

    html = f"""<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{safe_title} | AI MedStudio Tisk</title>
    <style>
        *, *::before, *::after {{
            box-sizing: border-box;
        }}
        body {{
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
            color: #0f172a;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }}
        .print-toolbar {{
            position: sticky;
            top: 0;
            z-index: 1000;
            background: #0f172a;
            color: #f8fafc;
            padding: 12px 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-size: 14px;
        }}
        .print-toolbar-title {{
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        .print-btn-primary {{
            background: #059669;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-weight: 700;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s ease;
        }}
        .print-btn-primary:hover {{
            background: #047857;
        }}
        .print-btn-secondary {{
            background: #334155;
            color: #cbd5e1;
            border: none;
            padding: 8px 14px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.15s ease;
        }}
        .print-btn-secondary:hover {{
            background: #475569;
            color: white;
        }}
        .page-sheet {{
            max-width: 860px;
            margin: 24px auto;
            background: white;
            padding: 48px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.06);
            border: 1px solid #e2e8f0;
        }}
        .doc-header {{
            border-bottom: 2px solid #0f172a;
            padding-bottom: 16px;
            margin-bottom: 28px;
        }}
        .doc-badge {{
            display: inline-block;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #059669;
            margin-bottom: 6px;
        }}
        .doc-title {{
            font-size: 26px;
            font-weight: 800;
            margin: 0 0 8px 0;
            color: #0f172a;
            line-height: 1.25;
        }}
        .doc-meta {{
            font-size: 12px;
            color: #64748b;
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }}
        /* Typography */
        .markdown-content h1 {{ font-size: 20px; font-weight: 800; margin: 24px 0 12px 0; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px; page-break-after: avoid; color: #0f172a; }}
        .markdown-content h2 {{ font-size: 17px; font-weight: 700; margin: 20px 0 10px 0; page-break-after: avoid; color: #1e293b; }}
        .markdown-content h3 {{ font-size: 15px; font-weight: 700; margin: 16px 0 8px 0; page-break-after: avoid; color: #334155; }}
        .markdown-content h4 {{ font-size: 14px; font-weight: 700; margin: 14px 0 6px 0; page-break-after: avoid; color: #475569; }}
        .markdown-content p {{ margin: 0 0 12px 0; }}
        .markdown-content ul, .markdown-content ol {{ margin: 0 0 14px 0; padding-left: 24px; }}
        .markdown-content li {{ margin-bottom: 6px; }}
        .markdown-content table {{
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
            font-size: 12.5px;
            page-break-inside: avoid;
        }}
        .markdown-content th, .markdown-content td {{
            border: 1px solid #cbd5e1;
            padding: 8px 10px;
            text-align: left;
            vertical-align: top;
        }}
        .markdown-content th {{
            background-color: #f1f5f9;
            font-weight: 700;
            color: #0f172a;
        }}
        .markdown-content tr:nth-child(even) {{
            background-color: #f8fafc;
        }}
        .markdown-content blockquote {{
            border-left: 4px solid #0ea5e9;
            margin: 14px 0;
            padding: 8px 16px;
            background: #f0f9ff;
            color: #0369a1;
            border-radius: 0 6px 6px 0;
        }}
        .markdown-content pre, .markdown-content code {{
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
        }}
        .markdown-content code {{
            background: #f1f5f9;
            color: #0f172a;
            padding: 2px 5px;
            border-radius: 4px;
            border: 1px solid #e2e8f0;
        }}
        .markdown-content pre {{
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            page-break-inside: avoid;
        }}
        .markdown-content sup {{
            font-weight: 700;
            color: #0369a1;
            font-size: 9px;
            padding: 1px 4px;
            background: #e0f2fe;
            border-radius: 3px;
            margin-left: 2px;
        }}
        .doc-footer {{
            margin-top: 40px;
            padding-top: 16px;
            border-top: 1px solid #e2e8f0;
            font-size: 11px;
            color: #94a3b8;
            display: flex;
            justify-content: space-between;
        }}

        @media print {{
            body {{
                background: white !important;
                color: black !important;
            }}
            .print-toolbar {{
                display: none !important;
            }}
            .page-sheet {{
                max-width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
            }}
            @page {{
                size: A4;
                margin: 16mm 14mm 16mm 14mm;
            }}
            a {{
                text-decoration: none;
                color: inherit;
            }}
        }}
    </style>
</head>
<body>
    <div class="print-toolbar">
        <div class="print-toolbar-title">
            <span>🩺 AI MedStudio</span>
            <span style="opacity: 0.5;">|</span>
            <span style="font-weight: 500; font-size: 13px;">Tiskový náhled: {safe_title}</span>
        </div>
        <div style="display: flex; gap: 8px;">
            <button onclick="window.print()" class="print-btn-primary">
                <span>🖨️</span> Vytisknout / Uložit do PDF
            </button>
            <button onclick="window.close()" class="print-btn-secondary">
                Zavřít
            </button>
        </div>
    </div>
    <div class="page-sheet">
        <header class="doc-header">
            <div class="doc-badge">AI MedStudio &bull; Studijní materiály</div>
            <h1 class="doc-title">{safe_title}</h1>
            <div class="doc-meta">
                <span><strong>Projekt:</strong> {safe_project}</span>
                <span><strong>Vygenerováno:</strong> {date_str}</span>
            </div>
        </header>
        <article class="markdown-content">
            {rendered_body}
        </article>
        <footer class="doc-footer">
            <span>AI MedStudio – Vytvořeno pro lékařskou fakultu (RAG Syntéza & Citace)</span>
            <span>Vytištěno: {date_str}</span>
        </footer>
    </div>
    <script>
        window.addEventListener('load', function() {{
            setTimeout(function() {{
                window.print();
            }}, 350);
        }});
    </script>
</body>
</html>"""
    return HTMLResponse(content=html)

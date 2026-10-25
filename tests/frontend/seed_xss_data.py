"""
Naplní běžící testovací server daty s běžnými i škodlivými hodnotami pro kontrolu escapování (krok 1.6).
Použití: seed_xss_data.py PORT DATA_DIR  – jen proti dočasnému serveru s prázdným datovým adresářem.
"""

import http.cookiejar
import json
import os
import secrets
import sys
import urllib.request

port, data_dir = sys.argv[1], sys.argv[2]
base = f"http://127.0.0.1:{port}"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None):
    req = urllib.request.Request(
        base + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with opener.open(req) as r:
        return r.status, json.loads(r.read() or b"null")


pw = secrets.token_urlsafe(12)
call("POST", "/api/auth/setup", {"username": "v16admin", "password": pw})
open(os.path.join(data_dir, "pw.txt"), "w").write(pw)
P = "xss_proj"
call("POST", "/api/projects", {"name": P})
X = "');window.__xss=1;//"
call(
    "POST",
    f"/api/projects/{P}/questions",
    {
        "questions": [
            {"id": "q1", "title": "Normální otázka & další", "number": 1, "topic": "Kardio"},
            {
                "id": "q2" + X,
                "title": 'Ot"ázka <img src=x onerror=window.__xss=1>',
                "number": "2<b>x</b>",
                "topic": "<i>t</i>",
                "grade": "<b>B</b>",
            },
        ]
    },
)
call("POST", "/api/chat/threads", {"project_id": P, "id": "thread_ok1", "title": "Běžné vlákno"})
call(
    "POST", "/api/chat/threads", {"project_id": P, "id": "thread_x" + X, "title": '<img src=x onerror=window.__xss=1>"'}
)


def w(rel, content):
    path = os.path.join(data_dir, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w", encoding="utf-8").write(content)


bad_name = "x');window.__xss=1;("
w(f"uploads/{P}/doc_ok.txt", "obsah")
w(f"uploads/{P}/{bad_name}.txt", "obsah")
w(f"generated_notes/{P}_q1.md", '<!-- METADATA\n{"question": "Normální poznámka", "project": "xss_proj"}\n-->\n# A')
w(
    f"generated_notes/{P}_{bad_name}.md",
    '<!-- METADATA\n{"question": "<img src=x onerror=window.__xss=1>", "project": "xss_proj"}\n-->\n# B',
)
w(
    f"generated_flashcards/{P}_q1.json",
    json.dumps(
        {
            "question": "Běžná sada",
            "project": P,
            "cards": [{"front": "Co je A & B?", "back": "Odpověď", "source_ref": "[1, s. 2]"}],
            "sources": [{"id": "1", "filename": "kardio.pdf"}],
        }
    ),
)
w(
    f"generated_flashcards/{P}_{bad_name}.json",
    json.dumps(
        {
            "question": "<img src=x onerror=window.__xss=1>",
            "project": P,
            "cards": [
                {
                    "front": 'a" onmouseover="window.__xss=1',
                    "back": "b",
                    "source_ref": "[Zdroj: " + bad_name + ".pdf, s. 1]",
                }
            ],
            "sources": [],
        }
    ),
)
w(
    f"generated_tests/{P}_t1.json",
    json.dumps({"id": "t1", "filename": f"{P}_t1.json", "project": P, "title": "Běžný test", "questions": []}),
)
w(
    f"generated_tests/{P}_{bad_name}.json",
    json.dumps(
        {
            "id": "t2",
            "filename": f"{P}_{bad_name}.json",
            "project": P,
            "title": "<img src=x onerror=window.__xss=1>",
            "questions": [],
        }
    ),
)
w(f"generated_audio/{P}_q1.mp3", "a")
w(f"generated_audio/{P}_{bad_name}.mp3", "a")
print("seeded", port)

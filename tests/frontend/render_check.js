/*
 * Ruční kontrola rendereru markdownu (krok 1.4 auditu).
 *
 * Použití: otevřít aplikaci v prohlížeči, v konzoli vložit tento soubor a zavolat
 *   await runRenderCheck(<obsah tests/frontend/markdown_fixtures.json>)
 * Funkce vrátí HTML výstup `renderMarkdownWithKaTeX` pro každý vzorek a u škodlivých vzorků
 * informaci, zda se po vložení do DOM (a kliknutí / najetí na citace) spustil skript (window.__xss).
 * Parametr `baselineKey` uloží / porovná snapshot v localStorage (před a po změně).
 */
async function runRenderCheck(fixtures, baselineKey = null) {
    const outputs = {};
    for (const group of ["benign", "malicious"]) {
        for (const [name, markdown] of Object.entries(fixtures[group] || {})) {
            try {
                outputs[`${group}.${name}`] = renderMarkdownWithKaTeX(markdown);
            } catch (e) {
                outputs[`${group}.${name}`] = `ERROR: ${e}`;
            }
        }
    }

    const fired = {};
    const sandbox = document.createElement("div");
    sandbox.style.display = "none";
    document.body.appendChild(sandbox);
    for (const [key, html] of Object.entries(outputs)) {
        if (!key.startsWith("malicious.")) continue;
        window.__xss = 0;
        sandbox.innerHTML = html;
        sandbox.querySelectorAll("*").forEach((el) => {
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            if (el.classList.contains("inline-citation")) {
                try { el.dispatchEvent(new MouseEvent("click", { bubbles: false })); } catch (e) { /* ignorovat */ }
            }
        });
        await new Promise((r) => setTimeout(r, 300));
        const jsHref = [...sandbox.querySelectorAll("[href],[src]")].some((el) =>
            /^\s*javascript:/i.test(el.getAttribute("href") || el.getAttribute("src") || "")
        );
        fired[key] = window.__xss === 1 || jsHref;
    }
    sandbox.remove();

    const result = { outputs, xssFired: fired };
    if (baselineKey) {
        let baseline = null;
        try { baseline = JSON.parse(localStorage.getItem(baselineKey) || "null"); } catch (e) { baseline = null; }
        if (!baseline) {
            try { localStorage.setItem(baselineKey, JSON.stringify(outputs)); } catch (e) { /* ignorovat */ }
            result.baseline = "saved";
        } else {
            result.diff = Object.keys(outputs).filter((k) => outputs[k] !== baseline[k]);
        }
    }
    return result;
}

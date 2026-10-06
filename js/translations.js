/**
 * Browser port of app/shared/translation/translation_loader.py
 * Loads the bundled Chinese tag data so tag translation keeps working
 * without a Python backend.
 */
(function () {
    const DG = (window.DG = window.DG || {});
    const ASSET_BASE = "assets/zh_cn";

    const enToCn = new Map();
    const cnToEn = new Map();
    let loaded = false;
    let loadingPromise = null;

    function normalizeTag(tag) {
        return String(tag == null ? "" : tag).toLowerCase().trim();
    }

    // Minimal CSV field parser that understands quoted fields and "" escapes.
    function parseCsvLine(line) {
        const fields = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i += 1) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') {
                        current += '"';
                        i += 1;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ",") {
                fields.push(current);
                current = "";
            } else {
                current += ch;
            }
        }
        fields.push(current);
        return fields;
    }

    async function loadJsonTranslations() {
        const response = await fetch(`${ASSET_BASE}/all_tags_cn.json`);
        if (!response.ok) {
            throw new Error(`all_tags_cn.json ${response.status}`);
        }
        const data = await response.json();
        for (const [enTag, cnTrans] of Object.entries(data)) {
            const en = normalizeTag(enTag);
            const cn = String(cnTrans == null ? "" : cnTrans).trim();
            if (!en) {
                continue;
            }
            enToCn.set(en, cn);
            if (cn && !cnToEn.has(cn)) {
                cnToEn.set(cn, en);
            }
        }
    }

    async function loadCsvTranslations(fileName, reverse) {
        const response = await fetch(`${ASSET_BASE}/${fileName}`);
        if (!response.ok) {
            throw new Error(`${fileName} ${response.status}`);
        }
        const text = (await response.text()).replace(/^\uFEFF/, "");
        for (const line of text.split(/\r?\n/)) {
            if (!line) {
                continue;
            }
            const row = parseCsvLine(line);
            if (row.length < 2) {
                continue;
            }
            let enTag;
            let cnTrans;
            if (reverse) {
                cnTrans = row[0].trim();
                enTag = normalizeTag(row[1]);
            } else {
                enTag = normalizeTag(row[0]);
                cnTrans = row[1].trim();
            }
            if (!enTag || !cnTrans) {
                continue;
            }
            if (!enToCn.has(enTag)) {
                enToCn.set(enTag, cnTrans);
            }
            if (!cnToEn.has(cnTrans)) {
                cnToEn.set(cnTrans, enTag);
            }
        }
    }

    async function ensureLoaded() {
        if (loaded) {
            return;
        }
        if (!loadingPromise) {
            loadingPromise = (async () => {
                await loadJsonTranslations();
                await loadCsvTranslations("danbooru.csv", false);
                await loadCsvTranslations("wai_characters.csv", true);
                loaded = true;
            })().catch((error) => {
                loadingPromise = null;
                throw error;
            });
        }
        await loadingPromise;
    }

    async function getChinese(englishTag) {
        await ensureLoaded();
        const tagNorm = normalizeTag(englishTag);
        if (enToCn.has(tagNorm)) {
            return enToCn.get(tagNorm) || null;
        }
        const withSpace = tagNorm.replace(/_/g, " ");
        if (enToCn.has(withSpace)) {
            return enToCn.get(withSpace) || null;
        }
        const withUnderscore = tagNorm.replace(/ /g, "_");
        if (enToCn.has(withUnderscore)) {
            return enToCn.get(withUnderscore) || null;
        }
        return null;
    }

    async function getEnglish(chineseText) {
        await ensureLoaded();
        return cnToEn.get(String(chineseText == null ? "" : chineseText).trim()) || null;
    }

    async function searchChinese(query, limit = 50) {
        await ensureLoaded();
        const queryNorm = String(query == null ? "" : query).trim().toLowerCase();
        if (!queryNorm) {
            return [];
        }
        const results = [];
        for (const [cnText, enTag] of cnToEn.entries()) {
            const cnLower = cnText.toLowerCase();
            let score = 0;
            if (cnLower === queryNorm) {
                score = 10;
            } else if (cnLower.startsWith(queryNorm)) {
                score = 8;
            } else if (cnLower.includes(queryNorm)) {
                score = 4;
            }
            if (score) {
                results.push({ tag: enTag, translation: cnText, score });
            }
        }
        results.sort((left, right) => right.score - left.score);
        return results.slice(0, limit).map((item) => ({
            tag: item.tag,
            translation_cn: item.translation,
            category: 0,
            post_count: 0,
            match_score: item.score,
        }));
    }

    async function translateBatch(tags) {
        await ensureLoaded();
        const translations = {};
        for (const tag of tags || []) {
            if (!tag) {
                continue;
            }
            const translation = await getChinese(tag);
            if (translation) {
                translations[tag] = translation;
            }
        }
        return translations;
    }

    DG.translations = {
        ensureLoaded,
        getChinese,
        getEnglish,
        searchChinese,
        translateBatch,
        isLoaded: () => loaded,
    };
})();

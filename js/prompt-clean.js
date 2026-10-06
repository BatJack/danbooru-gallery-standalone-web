/**
 * Browser port of app/core/prompt_cleaning_maid.py (+ the PromptFormatter helpers it uses).
 * Runs the whole prompt-cleaning pipeline client-side so GitHub Pages needs no backend.
 */
(function () {
    const DG = (window.DG = window.DG || {});

    const LORA_PATTERN = /<lora:[^>]+>/g;
    const SYNTAX_KEYWORDS = [
        "COUPLE", "MASK", "FEATHER", "FILL", "AND", "BREAK",
        "IMASK", "AREA", "MASK_SIZE", "MASKW",
    ];
    const COUPLE_MASK_PATTERN = /\bCOUPLE\s+MASK\s*\(/gi;
    const SYNTAX_PATTERNS = [
        /\bCOUPLE\s+MASK\s*\(/i,
        /\bCOUPLE\s*\(/i,
        /\bMASK\s*\(/i,
        /\bFEATHER\s*\(/i,
        /\bFILL\s*\(/i,
        /\bIMASK\s*\(/i,
        /\bAREA\s*\(/i,
        /\bMASK_SIZE\s*\(/i,
        /\bMASKW\s*\(/i,
    ];
    const REGION_SYNTAX_FUNCTIONS = ["COUPLE", "MASK", "FEATHER", "FILL", "IMASK", "AREA", "MASK_SIZE", "MASKW"];
    const AND_SEPARATOR_PATTERN = /\s+AND\s+/i;
    const MASK_OR_AREA_PATTERN = /\b(MASK|AREA|IMASK)\s*\(/i;
    const COMMA_LETTER_PATTERN = /,\s*[a-zA-Z_]/;
    const WEIGHT_PATTERN = /^([a-zA-Z0-9_\-\s]+):(\d*\.?\d+|:)$/;
    const KEYWORD_BOUNDARY_PATTERNS = [...REGION_SYNTAX_FUNCTIONS, "AND", "BREAK"].map((kw) => ({
        kw,
        pattern: new RegExp(`\\s+${kw}\\b`, "i"),
    }));

    function regionFuncPattern(func) {
        return new RegExp(`\\b${func}\\s*\\(`, "gi");
    }

    function isDigit(ch) {
        return ch >= "0" && ch <= "9";
    }

    function isAlpha(ch) {
        return /[A-Za-z]/.test(ch);
    }

    function countChar(text, ch) {
        let count = 0;
        for (let i = 0; i < text.length; i += 1) {
            if (text[i] === ch) {
                count += 1;
            }
        }
        return count;
    }

    function removeUnmatched(text, openCh, closeCh) {
        const stack = [];
        const removeIdx = new Set();
        for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (ch === openCh) {
                stack.push(i);
            } else if (ch === closeCh) {
                if (stack.length) {
                    stack.pop();
                } else {
                    removeIdx.add(i);
                }
            }
        }
        for (const index of stack) {
            removeIdx.add(index);
        }
        let result = "";
        for (let i = 0; i < text.length; i += 1) {
            if (!removeIdx.has(i)) {
                result += text[i];
            }
        }
        return result;
    }

    function smartCommaSplit(prompt) {
        if (!prompt) {
            return [];
        }
        const result = [];
        let current = "";
        let depth = 0;
        for (const char of prompt) {
            if ("([{".includes(char)) {
                depth += 1;
            } else if (")]}".includes(char)) {
                depth = Math.max(0, depth - 1);
            } else if ((char === "," || char === "，") && depth === 0) {
                result.push(current);
                current = "";
                continue;
            }
            current += char;
        }
        if (current) {
            result.push(current);
        }
        return result;
    }

    function containsSpecialSyntax(tag) {
        for (const pattern of SYNTAX_PATTERNS) {
            if (pattern.test(tag)) {
                return true;
            }
        }
        const tagUpper = tag.toUpperCase();
        for (const keyword of SYNTAX_KEYWORDS) {
            if (tagUpper.includes(keyword)) {
                return true;
            }
        }
        return false;
    }

    function containsMultiRegionSyntax(prompt) {
        const promptUpper = prompt.toUpperCase();
        if (promptUpper.includes("COUPLE")) {
            return true;
        }
        for (const func of REGION_SYNTAX_FUNCTIONS) {
            if (regionFuncPattern(func).test(prompt)) {
                return true;
            }
        }
        if (AND_SEPARATOR_PATTERN.test(prompt) && MASK_OR_AREA_PATTERN.test(prompt)) {
            return true;
        }
        return false;
    }

    function normalizeWeightSyntaxCustom(tag) {
        const match = WEIGHT_PATTERN.exec(tag.trim());
        if (match) {
            const content = match[1].trim();
            const weight = match[2];
            if (weight === ":") {
                return `(${content}:)`;
            }
            return `(${content}:${weight})`;
        }
        return tag;
    }

    function escapeBracketsInTagCustom(tag) {
        const result = [];
        let i = 0;
        while (i < tag.length) {
            if (tag[i] === "(") {
                let bracketDepth = 1;
                let j = i + 1;
                const contentStart = i + 1;
                while (j < tag.length && bracketDepth > 0) {
                    if (tag[j] === "(") {
                        bracketDepth += 1;
                    } else if (tag[j] === ")") {
                        bracketDepth -= 1;
                    } else if (tag[j] === "\\") {
                        j += 1;
                    }
                    j += 1;
                }

                if (bracketDepth === 0) {
                    const bracketContent = tag.slice(contentStart, j - 1);
                    let hasWordBefore = false;
                    if (i > 0) {
                        for (let k = i - 1; k >= 0; k -= 1) {
                            if (tag[k] !== " " && tag[k] !== "\t" && tag[k] !== "\n") {
                                hasWordBefore = true;
                                break;
                            }
                        }
                    }

                    if (hasWordBefore) {
                        if (bracketContent.includes(":") || bracketContent.includes(",")) {
                            result.push(", ");
                            result.push(`(${bracketContent})`);
                        } else {
                            if (tag[i - 1] !== " " && tag[i - 1] !== "\t" && tag[i - 1] !== "\n") {
                                result.push(" ");
                            }
                            result.push(`\\(${bracketContent}\\)`);
                        }
                        i = j;
                    } else if (bracketContent.includes(":")) {
                        result.push(`(${bracketContent})`);
                        i = j;
                    } else {
                        result.push(bracketContent);
                        i = j;
                    }
                } else {
                    result.push(tag[i]);
                    i += 1;
                }
            } else {
                result.push(tag[i]);
                i += 1;
            }
        }
        return result.join("");
    }

    function processSingleTagCustom(tag, underscoreToSpace, completeWeightSyntax, smartBracketEscaping) {
        if (underscoreToSpace) {
            if (!containsSpecialSyntax(tag)) {
                tag = tag.replace(/_/g, " ");
            } else {
                const protectedKeywords = ["MASK_SIZE", "mask_size"];
                for (const keyword of protectedKeywords) {
                    if (tag.includes(keyword)) {
                        const placeholder = `__PROTECTED_${keyword.replace("_", "")}__`;
                        tag = tag.split(keyword).join(placeholder);
                    }
                }
                tag = tag.replace(/_/g, " ");
                for (const keyword of protectedKeywords) {
                    const placeholder = `__PROTECTED_${keyword.replace("_", "")}__`;
                    tag = tag.split(placeholder.replace(/_/g, " ")).join(keyword);
                }
            }
        }

        if (completeWeightSyntax && !containsSpecialSyntax(tag)) {
            tag = normalizeWeightSyntaxCustom(tag);
        }

        if (smartBracketEscaping && !containsSpecialSyntax(tag)) {
            tag = escapeBracketsInTagCustom(tag);
        }

        return tag;
    }

    function applyCustomFormatting(prompt, underscoreToSpace, completeWeightSyntax, smartBracketEscaping, standardizeCommas) {
        if (!prompt || !prompt.trim()) {
            return prompt;
        }

        if (containsMultiRegionSyntax(prompt)) {
            if (underscoreToSpace) {
                const protectedKeywords = ["MASK_SIZE", "mask_size"];
                let result = prompt;
                for (const keyword of protectedKeywords) {
                    const placeholder = `__PROTECTED_${keyword}__`;
                    result = result.split(keyword).join(placeholder);
                }
                result = result.replace(/_/g, " ");
                for (const keyword of protectedKeywords) {
                    const placeholder = `__PROTECTED_${keyword}__`;
                    result = result.split(placeholder.replace(/_/g, " ")).join(keyword);
                }
                return result;
            }
            return prompt;
        }

        const tags = [];
        for (const rawTag of smartCommaSplit(prompt)) {
            const tag = rawTag.trim();
            if (!tag) {
                continue;
            }
            tags.push(processSingleTagCustom(tag, underscoreToSpace, completeWeightSyntax, smartBracketEscaping));
        }

        return standardizeCommas ? tags.join(", ") : tags.join(",");
    }

    function findMatchingParen(text, openPos) {
        if (openPos >= text.length || text[openPos] !== "(") {
            return -1;
        }
        let stack = 1;
        for (let i = openPos + 1; i < text.length; i += 1) {
            if (text[i] === "(") {
                stack += 1;
            } else if (text[i] === ")") {
                stack -= 1;
                if (stack === 0) {
                    return i;
                }
            }
        }
        return -1;
    }

    function findNumericParamsEnd(text, funcName) {
        let i = 0;
        let lastNumberEnd = 0;
        let inNumber = false;
        let foundAnyNumber = false;

        while (i < text.length) {
            const char = text[i];

            if (isDigit(char) || char === ".") {
                if (!inNumber) {
                    let j = i;
                    while (j < text.length && (isDigit(text[j]) || text[j] === ".")) {
                        j += 1;
                    }
                    if (j < text.length && isAlpha(text[j])) {
                        if (foundAnyNumber) {
                            return lastNumberEnd;
                        }
                        break;
                    }
                    inNumber = true;
                    foundAnyNumber = true;
                }
                i += 1;
                lastNumberEnd = i;
            } else if (char === "-") {
                if (i + 1 < text.length && (isDigit(text[i + 1]) || text[i + 1] === ".")) {
                    inNumber = true;
                    foundAnyNumber = true;
                    i += 1;
                    while (i < text.length && (isDigit(text[i]) || text[i] === ".")) {
                        i += 1;
                    }
                    lastNumberEnd = i;
                    inNumber = false;
                } else {
                    if (foundAnyNumber) {
                        return lastNumberEnd;
                    }
                    break;
                }
            } else if (char === " " || char === "\t") {
                inNumber = false;
                i += 1;
            } else if (char === ",") {
                inNumber = false;
                i += 1;
                while (i < text.length && (text[i] === " " || text[i] === "\t")) {
                    i += 1;
                }
                if (i < text.length && (isDigit(text[i]) || text[i] === "." || text[i] === "-")) {
                    if (text[i] === "-") {
                        if (i + 1 < text.length && (isDigit(text[i + 1]) || text[i + 1] === ".")) {
                            continue;
                        }
                        return lastNumberEnd;
                    }
                    continue;
                }
                return lastNumberEnd;
            } else if (char === ")") {
                return i;
            } else {
                if (foundAnyNumber) {
                    return lastNumberEnd;
                }
                break;
            }
        }

        return lastNumberEnd > 0 ? lastNumberEnd : -1;
    }

    function findParamEnd(text, funcName = "MASK") {
        if (!text) {
            return 0;
        }

        if (funcName.toUpperCase() === "FILL") {
            const stripped = text.replace(/^\s+/, "");
            if (stripped.startsWith(")")) {
                return 0;
            }
            const parenPos = text.indexOf(")");
            if (parenPos !== -1) {
                return parenPos;
            }
            return 0;
        }

        const paramEnd = findNumericParamsEnd(text, funcName);
        if (paramEnd > 0) {
            return paramEnd;
        }

        let minPos = text.length;
        for (const { pattern } of KEYWORD_BOUNDARY_PATTERNS) {
            const match = pattern.exec(text);
            if (match && match.index < minPos) {
                minPos = match.index;
            }
        }
        if (minPos < text.length) {
            return minPos;
        }

        const newlinePos = text.indexOf("\n");
        if (newlinePos !== -1) {
            return newlinePos;
        }

        const commaMatch = COMMA_LETTER_PATTERN.exec(text);
        if (commaMatch) {
            return commaMatch.index;
        }

        return -1;
    }

    function fixFunctionBrackets(text, funcName) {
        const pattern = regionFuncPattern(funcName);
        const result = [];
        let lastEnd = 0;

        for (const match of text.matchAll(pattern)) {
            const start = match.index;
            const parenStart = start + match[0].length - 1;
            result.push(text.slice(lastEnd, start));

            const closingPos = findMatchingParen(text, parenStart);
            if (closingPos === -1) {
                const funcCall = text.slice(start, start + match[0].length);
                const remaining = text.slice(start + match[0].length);
                const repairPos = findParamEnd(remaining, funcName);
                if (repairPos > 0) {
                    const params = remaining.slice(0, repairPos).replace(/\s+$/, "");
                    result.push(funcCall + params + ")");
                    lastEnd = start + match[0].length + repairPos;
                } else {
                    result.push(funcCall + ")");
                    lastEnd = start + match[0].length;
                }
            } else {
                result.push(text.slice(start, closingPos + 1));
                lastEnd = closingPos + 1;
            }
        }

        result.push(text.slice(lastEnd));
        return result.join("");
    }

    function cleanExtraParens(text) {
        const funcPositions = [];
        for (const func of REGION_SYNTAX_FUNCTIONS) {
            const pattern = regionFuncPattern(func);
            for (const match of text.matchAll(pattern)) {
                const parenStart = match.index + match[0].length - 1;
                const closingPos = findMatchingParen(text, parenStart);
                if (closingPos !== -1) {
                    funcPositions.push([parenStart, closingPos]);
                }
            }
        }

        if (!funcPositions.length) {
            return text;
        }

        funcPositions.sort((left, right) => left[0] - right[0]);
        const charsToRemove = new Set();

        for (const [, closingPos] of funcPositions) {
            let i = closingPos + 1;
            while (i < text.length && (text[i] === " " || text[i] === "\t")) {
                i += 1;
            }
            while (i < text.length && text[i] === ")") {
                const leftCount = countChar(text.slice(0, i), "(");
                const rightCount = countChar(text.slice(0, i + 1), ")");
                if (rightCount > leftCount) {
                    charsToRemove.add(i);
                }
                i += 1;
            }
        }

        let result = "";
        for (let idx = 0; idx < text.length; idx += 1) {
            if (!charsToRemove.has(idx)) {
                result += text[idx];
            }
        }
        return result;
    }

    function fixRegionSyntax(prompt) {
        if (!prompt) {
            return prompt;
        }
        let result = prompt.replace(COUPLE_MASK_PATTERN, "COUPLE(");
        for (const func of REGION_SYNTAX_FUNCTIONS) {
            result = fixFunctionBrackets(result, func);
        }
        result = cleanExtraParens(result);
        return result;
    }

    const NEWLINE_VALUES = {
        "否 (false)": "false",
        "空格 (space)": "space",
        "逗号 (comma)": "comma",
    };
    const FIX_BRACKET_VALUES = {
        "否 (false)": "false",
        "圆括号 (parenthesis)": "(parenthesis)",
        "方括号 (brackets)": "[brackets]",
        "两者 (both)": "([both])",
    };
    const FIX_BRACKET_PLAIN = {
        false: "false",
        parenthesis: "(parenthesis)",
        brackets: "[brackets]",
        both: "([both])",
    };

    function clean(input, options = {}) {
        let string = input == null ? "" : String(input);
        if (string === "") {
            return "";
        }

        const cleanupCommas = options.cleanup_commas !== false;
        const cleanupWhitespace = options.cleanup_whitespace !== false;
        const removeLoraTags = options.remove_lora_tags === true;
        let cleanupNewlines = options.cleanup_newlines == null ? "false" : String(options.cleanup_newlines);
        let fixBrackets = options.fix_brackets == null ? "both" : String(options.fix_brackets);
        const promptFormatting = options.prompt_formatting !== false;
        const underscoreToSpace = options.underscore_to_space !== false;
        const completeWeightSyntax = options.complete_weight_syntax !== false;
        const smartBracketEscaping = options.smart_bracket_escaping !== false;
        const standardizeCommas = options.standardize_commas !== false;
        const fixRegion = options.fix_region_syntax !== false;

        cleanupNewlines = NEWLINE_VALUES[cleanupNewlines] || cleanupNewlines;
        fixBrackets = FIX_BRACKET_VALUES[fixBrackets] || FIX_BRACKET_PLAIN[fixBrackets] || fixBrackets;

        if (removeLoraTags) {
            string = string.replace(LORA_PATTERN, "");
        }

        const hasMultiRegionSyntax = containsMultiRegionSyntax(string);

        if (fixRegion && hasMultiRegionSyntax) {
            string = fixRegionSyntax(string);
        }

        if (cleanupNewlines !== "false") {
            if (hasMultiRegionSyntax) {
                if (cleanupNewlines === "space" || cleanupNewlines === "comma") {
                    string = string.replace(/\n/g, " ");
                }
            } else if (cleanupNewlines === "space") {
                string = string.replace(/\n/g, " ");
            } else if (cleanupNewlines === "comma") {
                string = string.replace(/\n/g, ", ");
            }
        }

        if (promptFormatting) {
            string = applyCustomFormatting(
                string,
                underscoreToSpace,
                completeWeightSyntax,
                smartBracketEscaping,
                standardizeCommas,
            );
        }

        if (cleanupCommas && !promptFormatting) {
            while (/^[ \t]*,/.test(string)) {
                string = string.replace(/^[ \t]*,[ \t]*/, "");
            }
            while (/[ \t]*,[ \t]*$/.test(string)) {
                string = string.replace(/[ \t]*,[ \t]*$/, "");
            }
            while (/,[ \t]*,/.test(string)) {
                string = string.replace(/,[ \t]*,/, ",");
            }
        }

        if (fixBrackets !== "false" && !promptFormatting) {
            if (fixBrackets === "(parenthesis)" || fixBrackets === "([both])") {
                string = removeUnmatched(string, "(", ")");
            }
            if (fixBrackets === "[brackets]" || fixBrackets === "([both])") {
                string = removeUnmatched(string, "[", "]");
            }
        }

        if (cleanupWhitespace) {
            string = string.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
            string = string.replace(/[ \t]{2,}/g, " ");
            string = string.replace(/[ \t]*,[ \t]*/g, ", ");
        }

        return string;
    }

    DG.promptClean = {
        clean,
        // exposed for tests
        _smartCommaSplit: smartCommaSplit,
        _containsMultiRegionSyntax: containsMultiRegionSyntax,
    };
})();

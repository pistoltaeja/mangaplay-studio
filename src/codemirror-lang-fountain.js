// @ts-check
/**
 * codemirror-lang-fountain.js — CM6 LanguageSupport for strict Fountain.
 *
 * Reuses the same `mangaplayHighlighting()` style sheet downstream — only
 * the structure of the parse tree differs (Section / Synopsis are new;
 * Page / Panel are gone). Token → tag mapping mirrors the mangaplay
 * wrapper so styling is consistent across formats.
 */

import { LRLanguage, LanguageSupport, foldNodeProp, foldInside } from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "../grammar/fountain.grammar.js";

const fountainLanguage = LRLanguage.define({
    parser: parser.configure({
        props: [
            styleTags({
                "Section/SectionTok": tags.heading1,
                "Synopsis/SynopsisTok": tags.heading3,
                "CharacterCue/CharacterCueTok": tags.keyword,
                "Dialogue/DialogueTok": tags.string,
                "Parenthetical/ParentheticalTok": tags.meta,
                "Action/ActionTok": tags.content,
                "Action/ForcedActionTok": tags.content,
                "SceneHeading/SceneHeadingTok": tags.heading2,
                "Transition/TransitionTok": tags.controlKeyword,
                "Note/NoteTok": tags.comment,
                "Boneyard/BoneyardTok": tags.comment,
                "Centered/CenteredTok": tags.contentSeparator,
                "Lyric/LyricTok": tags.contentSeparator,
                "PageBreak/PageBreakTok": tags.lineComment,
                "TitlePageEntry/TitlePageEntryTok": tags.definitionKeyword,
            }),
            foldNodeProp.add({
                Section: foldInside,
                Note: foldInside,
                Boneyard: foldInside,
            }),
        ],
    }),
    languageData: {
        commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
        indentOnInput: /^\s*$/,
        closeBrackets: { brackets: ["(", "[", "{", '"'] },
    },
});

/**
 * CM6 LanguageSupport for strict Fountain.
 * @returns {LanguageSupport}
 */
export function fountain()
{
    return new LanguageSupport(fountainLanguage);
}

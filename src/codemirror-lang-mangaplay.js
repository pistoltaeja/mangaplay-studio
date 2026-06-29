// @ts-check
/**
 * codemirror-lang-mangaplay.js — CM6 LanguageSupport for .mangaplay format.
 */

import { LRLanguage, LanguageSupport, indentNodeProp, foldNodeProp, foldInside } from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "../grammar/mangaplay.grammar.js";

const mangaplayLanguage = LRLanguage.define({
    parser: parser.configure({
        props: [
            // Selectors are "ParentRule/ChildNode": tag. The Mangaplay grammar
            // wraps each line-level token in a same-named rule (e.g.
            // `PageHeading { PageHeadingTok }`), so we tag the inner Tok node
            // qualified by its wrapper. Earlier `Page/PageHeading` selectors
            // matched nothing because the grammar has no `Page` parent node —
            // only `PageHeading`.
            styleTags({
                "PageHeading/PageHeadingTok": tags.heading1,
                "PanelHeading/PanelHeadingTok": tags.heading2,
                "CharacterCue/CharacterCueTok": tags.keyword,
                Dialogue: tags.string,
                Parenthetical: tags.meta,
                "Action/ActionTok": tags.content,
                "SFX/SFXTok": tags.emphasis,
                "TitleCard/TitleCardTok": tags.heading3,
                "SceneHeading/SceneHeadingTok": tags.heading2,
                "Transition/TransitionTok": tags.controlKeyword,
                "Note/NoteTok": tags.comment,
                "Boneyard/BoneyardTok": tags.comment,
                "Centered/CenteredTok": tags.contentSeparator,
                "Lyric/LyricTok": tags.contentSeparator,
                "PageBreak/PageBreakTok": tags.lineComment,
                "TitlePageEntry/TitlePageEntryTok": tags.definitionKeyword,
                "Comment/CommentTok": tags.lineComment,
                "Action/ForcedActionTok": tags.content,
            }),
            indentNodeProp.add({
                Dialogue: (context) => context.column(context.node.from) + 4,
            }),
            // `Page: foldInside` would fold the inside of a `Page` node, but
            // the grammar has no `Page` wrapper — line types sit directly
            // under `Script`. Folding by page would need a custom fold
            // function that spans from one PageHeading to the next; out of
            // scope here. Note / Boneyard wrap real content so foldInside
            // works for them.
            foldNodeProp.add({
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
 * CM6 LanguageSupport for .mangaplay.
 * @returns {LanguageSupport}
 */
export function mangaplay() {
    return new LanguageSupport(mangaplayLanguage);
}

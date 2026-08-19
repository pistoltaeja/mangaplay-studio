/**
 * Single entry point for serialising a Mangaplay AST back to source.
 *
 * Every visual-editor write MUST go through this helper so the user's
 * indent style is preserved across the Source → Visual → Source round
 * trip.  Without `{ indentStyle: ast.metadata.indentStyle ?? 'mixed' }`
 * the formatter normalises style B/C documents to style A on first
 * toggle (known round-trip risk: style normalises on first toggle without this).
 */

import { formatMangaplay } from '@mangaplay-studio/core';

/**
 * Serialise an AST to a `.mangaplay` source string while preserving the
 * user's indent style.
 *
 * @param {import('@mangaplay-studio/core').ScriptAST} ast
 * @returns {string}
 */
export function formatScript(ast)
{
    const indentStyle = ast?.metadata?.indentStyle ?? 'mixed';
    return formatMangaplay(ast, { indentStyle });
}

/**
 * Unit tests for render-preference.js.
 *
 * NOTE — this test file is not wired into the harness `bun run test` script;
 * it's invoked directly as `bun test ./src/js/project/render-preference.test.js`
 * as agreed for isolated files during initial development.
 */

import { describe, test, expect } from "bun:test";
import {
    getRenderPreference,
    setRenderPreference,
    clearRenderPreference,
} from "./render-preference.js";

describe("getRenderPreference", () =>
{
    test("null → mangaart", () =>
    {
        expect(getRenderPreference(null)).toBe("mangaart");
    });

    test("undefined → mangaart", () =>
    {
        expect(getRenderPreference(undefined)).toBe("mangaart");
    });

    test("empty object → mangaart", () =>
    {
        expect(getRenderPreference({})).toBe("mangaart");
    });

    test('renderPreference: "slides" → slides', () =>
    {
        expect(getRenderPreference({ renderPreference: "slides" })).toBe("slides");
    });

    test('renderPreference: "mangaart" (explicit) → mangaart', () =>
    {
        expect(getRenderPreference({ renderPreference: "mangaart" })).toBe("mangaart");
    });

    test("unrecognised value falls through to mangaart", () =>
    {
        expect(getRenderPreference({ renderPreference: "nonsense" })).toBe("mangaart");
    });
});

describe("setRenderPreference", () =>
{
    test('sets renderPreference to "slides"', () =>
    {
        const result = setRenderPreference({}, "slides");
        expect(result.renderPreference).toBe("slides");
    });

    test('spreads existing fields when setting "slides"', () =>
    {
        const result = setRenderPreference({ foo: 1 }, "slides");
        expect(result).toEqual({ foo: 1, renderPreference: "slides" });
    });

    test('"mangaart" drops the field rather than writing it', () =>
    {
        const result = setRenderPreference({ foo: 1 }, "mangaart");
        expect(result).toEqual({ foo: 1 });
        expect("renderPreference" in result).toBe(false);
    });

    test('"mangaart" strips an existing "slides" value', () =>
    {
        const result = setRenderPreference({ foo: 1, renderPreference: "slides" }, "mangaart");
        expect(result).toEqual({ foo: 1 });
    });

    test("does not mutate the input object", () =>
    {
        const input = { foo: 1, bar: { nested: true } };
        const snapshot = JSON.parse(JSON.stringify(input));
        setRenderPreference(input, "slides");
        expect(input).toEqual(snapshot);
    });

    test("does not mutate the input object when clearing", () =>
    {
        const input = { foo: 1, renderPreference: "slides" };
        const snapshot = JSON.parse(JSON.stringify(input));
        setRenderPreference(input, "mangaart");
        expect(input).toEqual(snapshot);
    });
});

describe("clearRenderPreference", () =>
{
    test('removes "slides" and preserves other fields', () =>
    {
        const result = clearRenderPreference({ renderPreference: "slides", foo: 1 });
        expect(result).toEqual({ foo: 1 });
    });

    test("no crash on empty object", () =>
    {
        expect(clearRenderPreference({})).toEqual({});
    });

    test("null passes through", () =>
    {
        expect(clearRenderPreference(null)).toBe(null);
    });

    test("undefined passes through", () =>
    {
        expect(clearRenderPreference(undefined)).toBe(undefined);
    });

    test("does not mutate the input object", () =>
    {
        const input = { foo: 1, renderPreference: "slides" };
        const snapshot = JSON.parse(JSON.stringify(input));
        clearRenderPreference(input);
        expect(input).toEqual(snapshot);
    });
});

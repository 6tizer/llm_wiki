import { describe, expect, it } from "vitest";
import {
	createGraphNodeHoverRenderer,
	graphThemePalette,
	type GraphThemePalette,
} from "./graph-hover-renderer";

type Rgb = { r: number; g: number; b: number };

class MockCanvasContext {
	calls: Array<{ name: string; args: unknown[] }> = [];

	private record(name: string, ...args: unknown[]) {
		this.calls.push({ name, args });
	}

	set shadowOffsetX(value: number) {
		this.record("set:shadowOffsetX", value);
	}

	set shadowOffsetY(value: number) {
		this.record("set:shadowOffsetY", value);
	}

	set shadowBlur(value: number) {
		this.record("set:shadowBlur", value);
	}

	set shadowColor(value: string) {
		this.record("set:shadowColor", value);
	}

	set fillStyle(value: string) {
		this.record("set:fillStyle", value);
	}

	set strokeStyle(value: string) {
		this.record("set:strokeStyle", value);
	}

	set lineWidth(value: number) {
		this.record("set:lineWidth", value);
	}

	set font(value: string) {
		this.record("set:font", value);
	}

	save() {
		this.record("save");
	}

	restore() {
		this.record("restore");
	}

	beginPath() {
		this.record("beginPath");
	}

	moveTo(...args: number[]) {
		this.record("moveTo", ...args);
	}

	lineTo(...args: number[]) {
		this.record("lineTo", ...args);
	}

	quadraticCurveTo(...args: number[]) {
		this.record("quadraticCurveTo", ...args);
	}

	arc(...args: number[]) {
		this.record("arc", ...args);
	}

	closePath() {
		this.record("closePath");
	}

	fill() {
		this.record("fill");
	}

	stroke() {
		this.record("stroke");
	}

	fillText(...args: [string, number, number]) {
		this.record("fillText", ...args);
	}

	measureText(text: string) {
		this.record("measureText", text);
		return { width: text.length * 9 };
	}
}

function parseColor(value: string, fallback: Rgb): Rgb {
	if (value.startsWith("#")) {
		return {
			r: Number.parseInt(value.slice(1, 3), 16),
			g: Number.parseInt(value.slice(3, 5), 16),
			b: Number.parseInt(value.slice(5, 7), 16),
		};
	}
	const match = value.match(
		/^rgba\((\d+),(\d+),(\d+),(0(?:\.\d+)?|1(?:\.0+)?)\)$/,
	);
	if (!match) throw new Error(`Unsupported color: ${value}`);
	const alpha = Number(match[4]);
	return {
		r: Math.round(Number(match[1]) * alpha + fallback.r * (1 - alpha)),
		g: Math.round(Number(match[2]) * alpha + fallback.g * (1 - alpha)),
		b: Math.round(Number(match[3]) * alpha + fallback.b * (1 - alpha)),
	};
}

function luminance({ r, g, b }: Rgb): number {
	const channel = (value: number) => {
		const normalized = value / 255;
		return normalized <= 0.03928
			? normalized / 12.92
			: ((normalized + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
	const bright = Math.max(luminance(a), luminance(b));
	const dark = Math.min(luminance(a), luminance(b));
	return (bright + 0.05) / (dark + 0.05);
}

function hoverContrast(palette: GraphThemePalette, fallback: Rgb): number {
	return contrastRatio(
		parseColor(palette.hoverLabelText, fallback),
		parseColor(palette.hoverLabelBackground, fallback),
	);
}

function renderHover(label: string | null, isDark = false) {
	const palette = graphThemePalette(isDark);
	const renderer = createGraphNodeHoverRenderer(palette);
	const context = new MockCanvasContext();
	const settings = {
		labelSize: 14,
		labelFont: "Geist",
		labelWeight: "bold",
	} as Parameters<typeof renderer>[2];
	renderer(
		context as unknown as CanvasRenderingContext2D,
		{
			x: 10,
			y: 12,
			size: 8,
			label,
			color: "#94a3b8",
		},
		settings,
	);
	return { context, palette };
}

describe("graph hover renderer", () => {
	it("keeps hover label colors readable in light and dark mode", () => {
		expect(hoverContrast(graphThemePalette(false), { r: 255, g: 255, b: 255 }))
			.toBeGreaterThanOrEqual(4.5);
		expect(hoverContrast(graphThemePalette(true), { r: 2, g: 6, b: 23 }))
			.toBeGreaterThanOrEqual(4.5);
	});

	it("draws a high-contrast label pill for hovered nodes", () => {
		const { context, palette } = renderHover("Vector Database");
		const calls = context.calls.map((call) => call.name);
		const fillText = context.calls.find((call) => call.name === "fillText");
		const fillStyles = context.calls.filter((call) => call.name === "set:fillStyle");
		const finalFillStyle = fillStyles[fillStyles.length - 1];

		expect(calls).toContain("measureText");
		expect(fillText?.args[0]).toBe("Vector Database");
		expect(finalFillStyle?.args[0]).toBe(palette.hoverLabelText);
		expect(calls.indexOf("measureText")).toBeLessThan(calls.indexOf("fillText"));
		expect(calls.filter((name) => name === "fill").length).toBeGreaterThanOrEqual(2);
		expect(context.calls.flatMap((call) => call.args).filter((arg) => typeof arg === "number"))
			.toEqual(expect.arrayContaining([expect.any(Number)]));
	});

	it("does not draw text when the hovered node has no label", () => {
		const { context } = renderHover(null);

		expect(context.calls.some((call) => call.name === "fillText")).toBe(false);
		expect(context.calls.some((call) => call.name === "arc")).toBe(true);
	});

	it("uses dark-mode hover colors when drawing dark graph labels", () => {
		const { context, palette } = renderHover("暗色标签", true);
		const fillStyles = context.calls
			.filter((call) => call.name === "set:fillStyle")
			.map((call) => call.args[0]);
		const strokeStyles = context.calls
			.filter((call) => call.name === "set:strokeStyle")
			.map((call) => call.args[0]);
		const shadowColors = context.calls
			.filter((call) => call.name === "set:shadowColor")
			.map((call) => call.args[0]);

		expect(fillStyles).toContain(palette.hoverLabelBackground);
		expect(fillStyles).toContain(palette.hoverLabelText);
		expect(strokeStyles).toContain(palette.hoverLabelBorder);
		expect(shadowColors).toContain(palette.hoverLabelShadow);
		expect(context.calls.find((call) => call.name === "fillText")?.args[0])
			.toBe("暗色标签");
	});
});

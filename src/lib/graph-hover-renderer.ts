import type { NodeHoverDrawingFunction } from "sigma/rendering";

export interface GraphThemePalette {
	defaultEdge: string;
	label: string;
	hoverLabelText: string;
	hoverLabelBackground: string;
	hoverLabelBorder: string;
	hoverLabelShadow: string;
	mutedNodeMixTarget: string;
	dimmedEdge: string;
	activeEdge: string;
}

/** Return graph canvas colors tuned for readable labels in light/dark mode. */
export function graphThemePalette(isDark: boolean): GraphThemePalette {
	return isDark
		? {
				defaultEdge: "rgba(100,116,139,0.18)",
				label: "#f8fafc",
				hoverLabelText: "#f8fafc",
				hoverLabelBackground: "rgba(15,23,42,0.94)",
				hoverLabelBorder: "rgba(148,163,184,0.38)",
				hoverLabelShadow: "rgba(2,6,23,0.55)",
				mutedNodeMixTarget: "#334155",
				dimmedEdge: "rgba(71,85,105,0.12)",
				activeEdge: "#38bdf8",
			}
		: {
				defaultEdge: "#cbd5e1",
				label: "#1e293b",
				hoverLabelText: "#0f172a",
				hoverLabelBackground: "rgba(255,255,255,0.97)",
				hoverLabelBorder: "rgba(15,23,42,0.14)",
				hoverLabelShadow: "rgba(15,23,42,0.18)",
				mutedNodeMixTarget: "#e2e8f0",
				dimmedEdge: "rgba(148,163,184,0.22)",
				activeEdge: "#1e293b",
			};
}

function drawRoundedRect(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	const safeRadius = Math.min(radius, width / 2, height / 2);
	context.beginPath();
	context.moveTo(x + safeRadius, y);
	context.lineTo(x + width - safeRadius, y);
	context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
	context.lineTo(x + width, y + height - safeRadius);
	context.quadraticCurveTo(
		x + width,
		y + height,
		x + width - safeRadius,
		y + height,
	);
	context.lineTo(x + safeRadius, y + height);
	context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
	context.lineTo(x, y + safeRadius);
	context.quadraticCurveTo(x, y, x + safeRadius, y);
	context.closePath();
}

/** Build a Sigma node-hover renderer with a high-contrast label pill. */
export function createGraphNodeHoverRenderer(
	palette: GraphThemePalette,
): NodeHoverDrawingFunction {
	return (context, data, settings) => {
		const label = typeof data.label === "string" ? data.label : "";
		const labelSize = settings.labelSize;
		const font = settings.labelFont;
		const weight = settings.labelWeight;
		const nodeRadius = Math.max(data.size, labelSize / 2) + 3;

		context.save();
		context.shadowOffsetX = 0;
		context.shadowOffsetY = 2;
		context.shadowBlur = 10;
		context.shadowColor = palette.hoverLabelShadow;
		context.fillStyle = palette.hoverLabelBackground;
		context.strokeStyle = palette.hoverLabelBorder;
		context.lineWidth = 1;

		context.beginPath();
		context.arc(data.x, data.y, nodeRadius, 0, Math.PI * 2);
		context.closePath();
		context.fill();
		context.stroke();

		if (label) {
			context.font = `${weight} ${labelSize}px ${font}`;
			const paddingX = 8;
			const paddingY = 4;
			const gap = 6;
			const textWidth = context.measureText(label).width;
			const boxWidth = Math.ceil(textWidth + paddingX * 2);
			const boxHeight = Math.ceil(labelSize + paddingY * 2);
			const boxX = data.x + nodeRadius + gap;
			const boxY = data.y - boxHeight / 2;

			drawRoundedRect(context, boxX, boxY, boxWidth, boxHeight, 5);
			context.fill();
			context.stroke();

			context.shadowBlur = 0;
			context.shadowOffsetY = 0;
			context.fillStyle = palette.hoverLabelText;
			context.fillText(label, boxX + paddingX, data.y + labelSize / 3);
		}

		context.restore();
	};
}

// Shared stylized chat → PDF pipeline used by the navbar and sidebar chat
// menus. Renders the hidden #full-messages-container preview into an A4 PDF
// with diagram-aware capture (mermaid/vega pre-rasterized to PNG) and
// break-aware pagination (cuts fall in gaps between content blocks).
//
// All work is on-demand within the user-initiated export: bounded polling,
// dynamic imports, no persistent timers.

import { tick } from 'svelte';

import { computePageCuts, mapCssBoxesToCanvas } from '$lib/utils/pdf-pagination.mjs';

export interface StylizedPdfOptions {
	title: string;
	containerId?: string;
	virtualWidth?: number;
	scale?: number;
	jpegQuality?: number;
	pageMarginMM?: number;
	diagramTimeoutMs?: number;
	diagramPollMs?: number;
}

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;

// Block-level leaves the pagination must not split. `tr` rather than `table`
// so long tables stay cuttable between rows; ancestors taller than a page are
// dropped by computePageCuts.
const ATOMIC_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, tr, img, svg, blockquote > *, hr';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForDiagramsRendered = async (
	root: HTMLElement,
	timeoutMs: number,
	pollMs: number
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!root.querySelector('[data-portico-diagram-state="pending"]')) {
			return true;
		}
		await sleep(pollMs);
	}
	console.warn('PDF export: timed out waiting for diagrams to render; exporting as-is');
	return false;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// The style that actually applies to a label's glyphs is on the deepest
// element containing text (mermaid classDefs put inline color there).
const findLabelTextElement = (fo: Element): Element | null => {
	const walker = document.createTreeWalker(fo, NodeFilter.SHOW_TEXT);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if ((node.textContent ?? '').trim()) {
			return node.parentElement;
		}
	}
	return null;
};

// Greedy word wrap using real text metrics: foreignObject labels wrap via
// CSS in the live render, so the SVG <text> replacement must re-wrap to the
// same box width or long labels overflow their nodes.
const wrapLabelLines = (paragraphs: string[], font: string, maxWidth: number): string[] => {
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx || maxWidth <= 0) {
		return paragraphs;
	}
	ctx.font = font;
	const lines: string[] = [];
	for (const paragraph of paragraphs) {
		let line = '';
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			const probe = line ? `${line} ${word}` : word;
			if (line && ctx.measureText(probe).width > maxWidth) {
				lines.push(line);
				line = word;
			} else {
				line = probe;
			}
		}
		if (line) {
			lines.push(line);
		}
	}
	return lines;
};

// Extract the paragraph runs of a foreignObject HTML label: text runs split
// on <br> and block-element boundaries (visual wrapping is re-applied by
// wrapLabelLines).
const extractLabelLines = (fo: Element): string[] => {
	const lines: string[] = [];
	let current = '';
	const flush = () => {
		const trimmed = current.trim();
		if (trimmed) {
			lines.push(trimmed);
		}
		current = '';
	};
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			current += node.textContent ?? '';
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) {
			return;
		}
		const tag = (node as Element).tagName.toLowerCase();
		if (tag === 'br') {
			flush();
			return;
		}
		const isBlock = tag === 'p' || tag === 'div';
		node.childNodes.forEach(walk);
		if (isBlock) {
			flush();
		}
	};
	fo.childNodes.forEach(walk);
	flush();
	return lines;
};

// Replace every <foreignObject> HTML label in the serialization clone with a
// plain SVG <text> element. Chromium taints any canvas that an SVG image with
// foreignObject content is drawn onto, so this conversion is what makes the
// PNG rasterization possible at all. Typography is measured from the
// corresponding laid-out label in the live clone.
const convertForeignObjectLabels = (svgClone: SVGSVGElement, liveSvg: SVGSVGElement): void => {
	const cloneFOs = Array.from(svgClone.querySelectorAll('foreignObject'));
	const liveFOs = Array.from(liveSvg.querySelectorAll('foreignObject'));

	cloneFOs.forEach((fo, index) => {
		const width = parseFloat(fo.getAttribute('width') ?? '0') || 0;
		const height = parseFloat(fo.getAttribute('height') ?? '0') || 0;
		const paragraphs = extractLabelLines(fo);
		if (paragraphs.length === 0) {
			fo.remove();
			return;
		}

		const liveLabel = liveFOs[index] ? findLabelTextElement(liveFOs[index]) : null;
		const style = liveLabel ? getComputedStyle(liveLabel) : null;
		const fontSize = style ? parseFloat(style.fontSize) || 14.5 : 14.5;
		const fontWeight = style?.fontWeight || '400';
		const fontFamily = style?.fontFamily || '"trebuchet ms", verdana, arial, sans-serif';
		const lineHeight = fontSize * 1.2;
		const lines = wrapLabelLines(
			paragraphs,
			`${fontWeight} ${fontSize}px ${fontFamily}`,
			Math.max(width - 4, 0)
		);

		const text = document.createElementNS(SVG_NS, 'text');
		text.setAttribute('text-anchor', 'middle');
		text.setAttribute('dominant-baseline', 'central');
		// Inline !important throughout: mermaid's embedded stylesheet carries
		// rules like `.label text { fill:#333 }` (beats presentation
		// attributes) and classDef emits `.cls > * { stroke:... !important }`
		// whose stroke INHERITS into SVG text and outlines every glyph —
		// foreignObject HTML text was immune to it, real <text> is not.
		text.setAttribute(
			'style',
			`fill: ${style?.color || '#333'} !important;` +
				' stroke: none !important;' +
				` font-size: ${fontSize}px !important;` +
				` font-weight: ${fontWeight} !important;` +
				` font-family: ${fontFamily} !important;`
		);

		// HTML label content flows from the TOP of the foreignObject box (the
		// box is sized to the content for node/edge labels but taller for
		// cluster titles), so lay lines out top-down rather than centering on
		// the box height.
		lines.forEach((line, i) => {
			const tspan = document.createElementNS(SVG_NS, 'tspan');
			tspan.setAttribute('x', String(width / 2));
			tspan.setAttribute('y', String((i + 0.5) * lineHeight));
			tspan.textContent = line;
			text.appendChild(tspan);
		});

		fo.replaceWith(text);
	});
};

// Turn an SVG element into a PNG data URL. Throws on tainted canvases (any
// SVG containing <foreignObject> taints the canvas in Chromium — the
// foreignObject→text conversion above is what prevents that).
const svgToPngDataUrl = async (
	svgEl: SVGSVGElement,
	width: number,
	height: number,
	scale: number
): Promise<string> => {
	const svgClone = svgEl.cloneNode(true) as SVGSVGElement;
	convertForeignObjectLabels(svgClone, svgEl);
	// Mermaid emits width="100%", which decodes at zero size inside an Image;
	// explicit pixel dimensions are load-bearing. preserveAspectRatio default
	// letterboxes rather than distorts if the intrinsic aspect differs.
	svgClone.setAttribute('width', String(width));
	svgClone.setAttribute('height', String(height));
	if (!svgClone.getAttribute('xmlns')) {
		svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	}

	const markup = new XMLSerializer().serializeToString(svgClone);
	const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
	try {
		const image = new Image();
		image.src = url;
		await image.decode();

		const canvas = document.createElement('canvas');
		canvas.width = Math.ceil(width * scale);
		canvas.height = Math.ceil(height * scale);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			throw new Error('no 2d context');
		}
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/png');
	} finally {
		URL.revokeObjectURL(url);
	}
};

// Replace each rendered diagram (SvgPanZoom wrapper + svg) in the clone with
// a pre-rasterized PNG <img> sized exactly like the original svg box, so the
// layout (and the atomic boxes collected from it) does not shift. On any
// failure the original node is left for html2canvas's native path (its own
// foreignObject text layout is approximate but legible).
const rasterizeDiagrams = async (cloneRoot: HTMLElement, scale: number): Promise<void> => {
	const diagrams = Array.from(
		cloneRoot.querySelectorAll<HTMLElement>('[data-portico-diagram][data-portico-diagram-state="rendered"]')
	);

	for (const el of diagrams) {
		// Drop UI chrome (SvgPanZoom's download/reset/copy buttons) from the
		// capture regardless of how the diagram itself ends up rendered.
		el.querySelectorAll('button').forEach((button) => button.remove());

		const svg = el.querySelector('svg');
		if (!svg) {
			continue;
		}
		const rect = svg.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) {
			continue;
		}

		try {
			const png = await svgToPngDataUrl(svg as SVGSVGElement, rect.width, rect.height, scale);
			const replacement = document.createElement('img');
			replacement.src = png;
			replacement.style.cssText = `width: ${rect.width}px; height: ${rect.height}px; display: block; margin: 0 auto;`;
			el.replaceChildren(replacement);
		} catch (error) {
			console.warn('PDF export: failed to rasterize diagram', error);
		}
	}
};

// Nodes and edge labels inside rendered diagrams count as atoms too, so that
// when a whole diagram is taller than a page (and thus uncuttable as a unit)
// the cut still falls between diagram rows instead of through a node.
const DIAGRAM_ATOM_SELECTOR =
	'[data-portico-diagram] svg g.node, [data-portico-diagram] svg g.edgeLabel, [data-portico-diagram] svg .cluster-label';

const collectAtomicBoxes = (cloneRoot: HTMLElement): Array<{ top: number; bottom: number }> => {
	const rootTop = cloneRoot.getBoundingClientRect().top;
	const boxes: Array<{ top: number; bottom: number }> = [];
	const nodes = [
		...Array.from(cloneRoot.querySelectorAll(ATOMIC_SELECTOR)),
		...Array.from(cloneRoot.querySelectorAll(DIAGRAM_ATOM_SELECTOR))
	];
	for (const node of nodes) {
		const rect = node.getBoundingClientRect();
		if (rect.height <= 0 || rect.width <= 0) {
			continue;
		}
		boxes.push({ top: rect.top - rootTop, bottom: rect.bottom - rootTop });
	}
	return boxes;
};

let inFlight = false;

/**
 * Export the mounted #full-messages-container preview as a stylized PDF.
 * Throws on failure so callers can surface a toast. The caller owns mounting
 * the preview (showFullMessages) and clearing it in its own finally block.
 */
export async function exportStylizedChatPdf({
	title,
	containerId = 'full-messages-container',
	virtualWidth = 800,
	scale = 2,
	jpegQuality = 0.7,
	pageMarginMM = 9,
	diagramTimeoutMs = 8000,
	diagramPollMs = 150
}: StylizedPdfOptions): Promise<void> {
	if (inFlight) {
		return;
	}
	inFlight = true;
	try {
		const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
			import('jspdf'),
			import('html2canvas-pro')
		]);

		const containerElement = document.getElementById(containerId);
		if (!containerElement) {
			throw new Error(`PDF export: container #${containerId} not found`);
		}

		await waitForDiagramsRendered(containerElement, diagramTimeoutMs, diagramPollMs);
		// Let the Svelte flush that swapped in the last rendered diagram commit.
		await tick();

		const isDarkMode = document.documentElement.classList.contains('dark');

		const clonedElement = containerElement.cloneNode(true) as HTMLElement;
		clonedElement.classList.add('text-black');
		clonedElement.classList.add('dark:text-white');
		clonedElement.style.width = `${virtualWidth}px`;
		clonedElement.style.position = 'absolute';
		clonedElement.style.left = '-9999px';
		clonedElement.style.height = 'auto';
		document.body.appendChild(clonedElement);

		try {
			await sleep(100);

			// Collect boxes before rasterization: the diagram-internal atoms
			// (svg g.node, ...) only exist pre-replacement, and the PNG
			// replacement is sized exactly like the original svg box so every
			// collected position stays valid.
			const cssBoxes = collectAtomicBoxes(clonedElement);
			await rasterizeDiagrams(clonedElement, scale);
			const cloneWidth = clonedElement.getBoundingClientRect().width || virtualWidth;

			const canvas = await html2canvas(clonedElement, {
				backgroundColor: isDarkMode ? '#000' : '#fff',
				useCORS: true,
				scale,
				width: virtualWidth
			});

			const ratio = canvas.width / cloneWidth;
			const pxPerMM = canvas.width / PAGE_WIDTH_MM;
			const usableHeightMM = PAGE_HEIGHT_MM - 2 * pageMarginMM;
			const pageHeightPx = Math.floor(pxPerMM * usableHeightMM);

			const cuts = computePageCuts({
				totalHeight: canvas.height,
				pageHeight: pageHeightPx,
				boxes: mapCssBoxesToCanvas(cssBoxes, ratio)
			});

			const pdf = new jsPDF('p', 'mm', 'a4');
			let offsetY = 0;

			cuts.forEach((cut, page) => {
				const sliceHeight = cut - offsetY;

				const pageCanvas = document.createElement('canvas');
				pageCanvas.width = canvas.width;
				pageCanvas.height = sliceHeight;

				const ctx = pageCanvas.getContext('2d');
				if (!ctx) {
					throw new Error('PDF export: failed to acquire 2d context');
				}
				ctx.drawImage(
					canvas,
					0,
					offsetY,
					canvas.width,
					sliceHeight,
					0,
					0,
					canvas.width,
					sliceHeight
				);

				const imgData = pageCanvas.toDataURL('image/jpeg', jpegQuality);
				const imgHeightMM = (sliceHeight * PAGE_WIDTH_MM) / canvas.width;

				if (page > 0) {
					pdf.addPage();
				}

				if (isDarkMode) {
					pdf.setFillColor(0, 0, 0);
					pdf.rect(0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM, 'F');
				}

				pdf.addImage(imgData, 'JPEG', 0, pageMarginMM, PAGE_WIDTH_MM, imgHeightMM);

				offsetY = cut;
			});

			pdf.save(`chat-${title}.pdf`);
		} finally {
			clonedElement.remove();
		}
	} finally {
		inFlight = false;
	}
}

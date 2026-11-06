// In-memory text zoom for reading surfaces (notes, summaries, chats).
// ⌘+ / ⌘- / ⌘0 adjust it; deliberately not persisted — resets on reload.
//
// Surfaces opt in by marking their content element with `data-text-zoom`
// and applying `style:zoom={textZoom.value}`. The shortcut only fires while
// such an element is visible, so it leaves the PDF viewer and other pages alone.

const STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7, 2];
const DEFAULT_INDEX = STEPS.indexOf(1);

let index = $state(DEFAULT_INDEX);

export const textZoom = {
	get value() {
		return STEPS[index];
	}
};

function hasVisibleZoomSurface(): boolean {
	return Array.from(document.querySelectorAll('[data-text-zoom]')).some(
		(el) => el.getClientRects().length > 0
	);
}

export function handleTextZoomKey(e: KeyboardEvent) {
	if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
	let next: number;
	if (e.key === '=' || e.key === '+') next = Math.min(index + 1, STEPS.length - 1);
	else if (e.key === '-' || e.key === '_') next = Math.max(index - 1, 0);
	else if (e.key === '0') next = DEFAULT_INDEX;
	else return;
	if (!hasVisibleZoomSurface()) return;
	e.preventDefault();
	index = next;
}

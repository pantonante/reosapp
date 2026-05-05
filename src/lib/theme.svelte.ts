export type Theme = 'dracula' | 'dark' | 'light' | 'solarized';

export const THEMES: { id: Theme; label: string; description: string; isDark: boolean }[] = [
	{ id: 'dracula', label: 'Dracula', description: 'Deep blue dark', isDark: true },
	{ id: 'dark', label: 'Dark', description: 'Neutral black', isDark: true },
	{ id: 'light', label: 'Light', description: 'Clean white', isDark: false },
	{ id: 'solarized', label: 'Solarized', description: 'Solarized light', isDark: false }
];

const KEY = 'reos:theme';
const VALID = new Set<Theme>(['dracula', 'dark', 'light', 'solarized']);

function readStored(): Theme {
	if (typeof localStorage === 'undefined') return 'dracula';
	const v = localStorage.getItem(KEY);
	return v && VALID.has(v as Theme) ? (v as Theme) : 'dracula';
}

function applyToDocument(t: Theme) {
	if (typeof document === 'undefined') return;
	document.documentElement.setAttribute('data-theme', t);
	const dark = t === 'dracula' || t === 'dark';
	document.documentElement.classList.toggle('dark', dark);
}

function createThemeStore() {
	let current = $state<Theme>(readStored());
	return {
		get current() {
			return current;
		},
		set(next: Theme) {
			current = next;
			if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next);
			applyToDocument(next);
		},
		apply() {
			applyToDocument(current);
		}
	};
}

export const theme = createThemeStore();

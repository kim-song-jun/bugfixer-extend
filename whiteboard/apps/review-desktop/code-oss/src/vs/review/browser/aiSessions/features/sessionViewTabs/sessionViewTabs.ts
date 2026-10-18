export type AgentSessionViewTab = 'terminal' | 'changes' | 'logs';

const labels: Readonly<Record<AgentSessionViewTab, string>> = { terminal: '터미널', changes: '변경 내역', logs: '로그' };

export function createSessionViewTabs(selected: AgentSessionViewTab, onSelect: (tab: AgentSessionViewTab) => void): HTMLElement {
	const nav = document.createElement('div');
	nav.className = 'ai-session__tabs';
	nav.setAttribute('role', 'tablist');
	nav.setAttribute('aria-label', '세션 보기');
	for (const tab of Object.keys(labels) as AgentSessionViewTab[]) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'ai-session__tab';
		button.id = `ai-session-tab-${tab}`;
		button.setAttribute('role', 'tab');
		button.setAttribute('aria-selected', String(tab === selected));
		button.setAttribute('tabindex', tab === selected ? '0' : '-1');
		button.textContent = labels[tab];
		button.addEventListener('click', () => onSelect(tab));
		button.addEventListener('keydown', event => {
			if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
			event.preventDefault();
			const next = (Object.keys(labels) as AgentSessionViewTab[])[((Object.keys(labels) as AgentSessionViewTab[]).indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
			onSelect(next);
			nav.querySelector<HTMLButtonElement>(`#ai-session-tab-${next}`)?.focus();
		});
		nav.appendChild(button);
	}
	return nav;
}


export function shouldSurfaceAttention({
    sameFolder,
    aiPaneVisible,
    pageVisible,
    pageFocused,
}: Readonly<{
    sameFolder: boolean;
    aiPaneVisible: boolean;
    pageVisible: boolean;
    pageFocused: boolean;
}>): boolean {
    return !(sameFolder && aiPaneVisible && pageVisible && pageFocused);
}
import {type PaneKind} from '@agent-storm/common';
import {type FrontendTab} from './router.js';

export const defaultTabOrder: ReadonlyArray<FrontendTab> = [
    'ai',
    'shell',
    'code',
];

export function sanitizeTabOrder(value: unknown): ReadonlyArray<FrontendTab> {
    if (!Array.isArray(value)) {
        return defaultTabOrder;
    }
    const tabs = value.filter(
        (entry): entry is FrontendTab =>
            typeof entry === 'string' && (defaultTabOrder as ReadonlyArray<string>).includes(entry),
    );
    if (tabs.length !== defaultTabOrder.length || new Set(tabs).size !== tabs.length) {
        return defaultTabOrder;
    }
    return tabs;
}

export function moveTabGroup(
    order: ReadonlyArray<FrontendTab>,
    draggedTabs: ReadonlyArray<FrontendTab>,
    targetTabs: ReadonlyArray<FrontendTab>,
    position: 'before' | 'after',
): ReadonlyArray<FrontendTab> {
    const dragged = new Set(draggedTabs);
    const targets = new Set(targetTabs);
    if ([...dragged].some((tab) => targets.has(tab))) {
        return order;
    }
    const draggedInOrder = order.filter((tab) => dragged.has(tab));
    const remaining = order.filter((tab) => !dragged.has(tab));
    const targetIndexes = remaining
        .map((tab, index) => (targets.has(tab) ? index : -1))
        .filter((index) => index >= 0);
    if (!draggedInOrder.length || !targetIndexes.length) {
        return order;
    }
    const insertionIndex =
        position === 'before' ? Math.min(...targetIndexes) : Math.max(...targetIndexes) + 1;
    return [
        ...remaining.slice(0, insertionIndex),
        ...draggedInOrder,
        ...remaining.slice(insertionIndex),
    ];
}

export type PaneAttentionRequest = Readonly<{
    folder: string;
    kind: PaneKind;
}>;

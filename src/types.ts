export interface HeaderEntry {
    name: string;
    value: string;
}

export interface LaneRule {
    id: string;
    name: string;
    shortName: string;
    headers: HeaderEntry[];
}

export interface TabBinding {
    tabId: number;
    ruleId: string;
}

export interface TabEmoji {
    tabId: number;
    emoji: string;
}

export interface PopupState {
    rules: LaneRule[];
    bindings: TabBinding[];
    activeRuleId: string | null;
    tab: { id: number; title: string; url: string; supported: boolean; emoji: string };
}

export type RequestMessage =
    | { type: 'GET_STATE'; tabId: number }
    | { type: 'SAVE_RULE'; tabId: number; rule: LaneRule }
    | { type: 'DELETE_RULE'; tabId: number; ruleId: string }
    | { type: 'APPLY_RULE'; tabId: number; ruleId: string | null }
    | { type: 'SET_TAB_EMOJI'; tabId: number; emoji: string }
    | { type: 'GET_TAB_INDICATOR' };

export type ResponseMessage =
    | { ok: true; state: PopupState }
    | { ok: false; error: string };

export interface IndicatorMessage {
    type: 'SET_TAB_INDICATOR';
    shortName: string | null;
    emoji: string;
}

import { create } from "zustand";

/**
 * One-shot handoff from the sidebar's "Summary" context-menu item to the chat
 * header: the sidebar navigates to the thread and parks its key here, and the
 * header's summary control opens itself once it is rendering that thread.
 * Session-only; nothing persists.
 */
interface ThreadSummaryUiStore {
  readonly pendingThreadKey: string | null;
  readonly requestOpen: (threadKey: string) => void;
  /** Clear the request once the popover has opened (or the thread changed). */
  readonly consume: (threadKey: string) => void;
}

export const useThreadSummaryUiStore = create<ThreadSummaryUiStore>((set) => ({
  pendingThreadKey: null,
  requestOpen: (threadKey) => set({ pendingThreadKey: threadKey }),
  consume: (threadKey) =>
    set((state) => (state.pendingThreadKey === threadKey ? { pendingThreadKey: null } : state)),
}));

/**
 * Shared action-sheet wrapper (apps/mobile/CLAUDE.md §UI components):
 * iOS presents the native ActionSheetIOS; Android presents a Material
 * bottom sheet (@gorhom/bottom-sheet) rendered by <AndroidActionSheetHost />
 * mounted once in app/_layout.tsx. Feature code must never import
 * ActionSheetIOS directly.
 *
 * The Android sheet is store-driven because this API is imperative — there
 * is no React context at the call site. `showActionSheetWithOptions` pushes
 * the config into the store and the host presents it. The host fires the
 * callback only after the sheet has fully dismissed — matching
 * ActionSheetIOS, so a follow-up sheet can present immediately (see the
 * nested React… flow in components/issue/comment-context-menu.tsx).
 */
import { ActionSheetIOS, Platform } from "react-native";
import { create } from "zustand";

export type ActionSheetOptions = Parameters<
  typeof ActionSheetIOS.showActionSheetWithOptions
>[0];
export type ActionSheetCallback = Parameters<
  typeof ActionSheetIOS.showActionSheetWithOptions
>[1];

interface ActiveSheet {
  options: ActionSheetOptions;
  callback: ActionSheetCallback;
}

interface AndroidActionSheetState {
  sheet: ActiveSheet | null;
  present: (options: ActionSheetOptions, callback: ActionSheetCallback) => void;
  clear: () => void;
}

export const useAndroidActionSheetStore = create<AndroidActionSheetState>(
  (set) => ({
    sheet: null,
    present: (options, callback) => set({ sheet: { options, callback } }),
    clear: () => set({ sheet: null }),
  }),
);

export function showActionSheetWithOptions(
  options: ActionSheetOptions,
  callback: ActionSheetCallback,
) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(options, callback);
    return;
  }

  if (options.options.length === 0) return;
  useAndroidActionSheetStore.getState().present(options, callback);
}

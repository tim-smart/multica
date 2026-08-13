/**
 * Android presentation layer for the shared action-sheet wrapper
 * (lib/action-sheet.ts). A @gorhom/bottom-sheet modal: backdrop fades in
 * over the viewport while the card slides up with spring physics, drag
 * handle + pan-down-to-close, dynamic height. Mounted once in
 * app/_layout.tsx (under <BottomSheetModalProvider />); renders nothing on
 * iOS or while no sheet is presented.
 *
 * Deliberate divergences from the iOS action sheet:
 *   - No Cancel row — backdrop tap, drag-down, and hardware back cancel,
 *     per Material convention. The cancel callback still fires so callers
 *     can clear pressed/highlight state.
 *
 * Callback timing: row taps stash the index and dismiss(); the callback
 * fires in onDismiss, after the close animation, matching ActionSheetIOS
 * so a follow-up sheet presented from the callback opens cleanly.
 */
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Text } from "@/components/ui/text";
import {
  useAndroidActionSheetStore,
  type ActionSheetOptions,
} from "@/lib/action-sheet";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";
import { cn } from "@/lib/utils";

export function AndroidActionSheetHost() {
  const sheet = useAndroidActionSheetStore((s) => s.sheet);
  const clear = useAndroidActionSheetStore((s) => s.clear);
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const t = THEME[colorScheme];

  const modalRef = useRef<BottomSheetModal>(null);
  const selectedRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!sheet) return;
    selectedRef.current = undefined;
    modalRef.current?.present();

    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      modalRef.current?.dismiss();
      return true;
    });
    return () => back.remove();
  }, [sheet]);

  const onDismiss = () => {
    clear();
    if (!sheet) return;
    const index = selectedRef.current ?? sheet.options.cancelButtonIndex;
    if (index !== undefined) sheet.callback(index);
  };

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.4}
      />
    ),
    [],
  );

  if (!sheet) return null;

  const { options, title, message, cancelButtonIndex, disabledButtonIndices } =
    sheet.options;

  return (
    <BottomSheetModal
      ref={modalRef}
      onDismiss={onDismiss}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      topInset={insets.top}
      backgroundStyle={{ backgroundColor: t.popover, borderRadius: 20 }}
      handleIndicatorStyle={{ backgroundColor: t.mutedForeground }}
    >
      <BottomSheetView style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        {title || message ? (
          <View className="px-6 pb-2">
            {title ? (
              <Text className="text-sm font-medium text-muted-foreground">
                {title}
              </Text>
            ) : null}
            {message ? (
              <Text className="text-xs text-muted-foreground mt-0.5">
                {message}
              </Text>
            ) : null}
          </View>
        ) : null}
        {options.map((label, index) => {
          if (index === cancelButtonIndex) return null;
          const disabled = disabledButtonIndices?.includes(index) === true;
          return (
            <Pressable
              key={index}
              disabled={disabled}
              onPress={() => {
                selectedRef.current = index;
                modalRef.current?.dismiss();
              }}
              className={cn(
                "px-6 py-3.5 active:bg-secondary",
                disabled && "opacity-40",
              )}
            >
              <Text
                className={cn(
                  "text-base",
                  isDestructive(sheet.options, index)
                    ? "text-destructive"
                    : "text-foreground",
                )}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

function isDestructive(options: ActionSheetOptions, index: number): boolean {
  const destructive = options.destructiveButtonIndex;
  return Array.isArray(destructive)
    ? destructive.includes(index)
    : destructive === index;
}

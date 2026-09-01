import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { chatKeys } from "@multica/core/chat/queries";
import type { TaskMessagePayload } from "@multica/core/types";
import type { ReactElement } from "react";
import enChat from "../../locales/en/chat.json";
import { ChatMessageList } from "./chat-message-list";

// Auto-scroll wiring: the list must keep the live end visible through streaming
// growth and composer resizes, releasing only on real reader input. The latch
// decision table is canonical in transcript-follow.test.ts and the scroll
// geometry in stick-to-bottom.test.ts; this suite drives the real component
// through the DOM signals those decisions are wired to. Reader gestures here
// are wheel INPUT followed by the scroll it causes — position-only moves model
// the browser (clamps), input-led moves model the reader.

// Virtuoso cannot render rows in jsdom's zero-height viewport. The stub keeps
// the row count visible, surfaces `followOutput` verdicts as attributes, and
// captures `totalListHeightChanged` so the harness can report content growth
// the way the real Virtuoso does.
let reportContentHeightChanged: (() => void) | undefined;

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    computeItemKey,
    followOutput,
    totalListHeightChanged,
  }: {
    data: unknown[];
    itemContent: (i: number, item: unknown) => ReactElement;
    computeItemKey: (i: number, item: unknown) => string;
    followOutput?: (atBottom: boolean) => "smooth" | "auto" | false;
    totalListHeightChanged?: () => void;
  }) => {
    reportContentHeightChanged = totalListHeightChanged;
    return (
      <div
        data-testid="virtuoso-rows"
        data-follow-at-bottom={String(followOutput?.(true))}
        data-follow-away-from-bottom={String(followOutput?.(false))}
      >
        {data.map((item, i) => (
          <div key={computeItemKey(i, item)} data-row-key={computeItemKey(i, item)}>
            {itemContent(i, item)}
          </div>
        ))}
      </div>
    );
  },
}));

const TEST_RESOURCES = { en: { chat: enChat } };
const TASK_ID = "6af44cbe-80ab-4dfe-b07d-bd3cfd588f4d";

const VIEWPORT = 600;

interface FakeObserver {
  targets: Element[];
  fire: () => void;
}

let observers: FakeObserver[] = [];
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;

function observedTargets(): Element[] {
  return observers.flatMap((o) => o.targets);
}

function fireResizeObservers() {
  act(() => {
    for (const observer of observers) observer.fire();
  });
}

function renderFrame() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  now += 16;
  for (const callback of callbacks) callback(now);
}

// Confirmed motion gets a short settle window; tests control that clock.
let now = 0;
function gestureSettles() {
  now += 301;
}

beforeEach(() => {
  observers = [];
  animationFrames = new Map();
  nextAnimationFrameId = 1;
  reportContentHeightChanged = undefined;
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = [];
      constructor(private callback: () => void) {
        observers.push(this as unknown as FakeObserver);
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve(target: Element) {
        this.targets = this.targets.filter((t) => t !== target);
      }
      disconnect() {
        this.targets = [];
        observers = observers.filter((o) => (o as unknown as this) !== this);
      }
      fire() {
        this.callback();
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Scroller {
  el: HTMLElement;
  scrollTop: number;
  distanceFromBottom(): number;
  /** A streamed chunk grew the content; Virtuoso reports the new height. */
  grow(px: number): void;
  /** Content shrank (a fold closing); the browser clamps scrollTop. */
  shrinkContent(px: number): void;
  /** The composer collapsed, giving the list `px` back; scrollTop clamps. */
  growViewport(px: number): void;
  /** The composer grew, taking `px` off the list's height. */
  shrinkViewport(px: number): void;
  /** Reader wheel input scrolling up by `px`, and the scroll it causes. */
  readerScrollsUp(px: number): void;
  /**
   * Wheel input alone: the browser answers a mouse wheel tick with ANIMATED
   * scrolling, so its displacement arrives over later frames (model those
   * with `browserScrollsListUp`).
   */
  wheelInput(px: number): void;
  /** Starts a one-finger touch gesture at `clientY`. */
  touchStart(clientY: number): void;
  /** Moves that finger and then scrolls the list up by `scrollPx`. */
  touchMove(clientY: number, scrollPx: number): void;
  touchEnd(): void;
  /** Touch momentum scrolls the list after the finger lifts. */
  touchMomentumScrollsUp(px: number): void;
  /** Reader wheel input landing `fromBottom` px above the live end. */
  readerScrollsTo(fromBottom: number): void;
  /**
   * Wheel input the list never consumed: it bubbles from a nested scroller
   * (or hits a list with nothing to scroll), so no scroll event follows.
   */
  wheelWithoutScroll(px: number): void;
  /** PageUp bubbling from a focused control inside a row. */
  pageUpFromRowControl(): void;
  /** Shift+Space (pages UP) bubbling from a focused control inside a row. */
  shiftSpaceFromRowControl(): void;
  /** The browser scrolls the list itself (answering a key), no input seen. */
  browserScrollsListUp(px: number): void;
}

function scroller(el: HTMLElement, initialContent = 2000): Scroller {
  const state = { scrollTop: 0, contentHeight: initialContent, viewportHeight: VIEWPORT };
  // Open at the bottom, matching Virtuoso's `initialTopMostItemIndex: LAST`.
  state.scrollTop = Math.max(0, state.contentHeight - state.viewportHeight);

  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => state.contentHeight },
    clientHeight: { configurable: true, get: () => state.viewportHeight },
    scrollTop: {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => {
        state.scrollTop = value;
      },
    },
  });

  const scrollEvent = () => {
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
  };

  const touchEvent = (type: string, clientY?: number) => {
    const event = new Event(type, { bubbles: true }) as TouchEvent;
    const points =
      clientY === undefined
        ? []
        : [{ identifier: 1, clientY } satisfies Pick<Touch, "identifier" | "clientY">];
    Object.defineProperty(event, "touches", {
      value: points,
    });
    Object.defineProperty(event, "changedTouches", { value: points });
    return event;
  };

  // Reader input: the wheel delta the hook judges intent from, then the
  // scroll it produces. Wheel up is a negative deltaY.
  const wheelBy = (px: number) => {
    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -px }));
    });
    state.scrollTop -= px;
    scrollEvent();
  };

  // Browser clamp after the scrollable extent shrank: scrollTop drops to the
  // new maximum and a scroll event fires, with no input anywhere.
  const clampAfterShrink = () => {
    state.scrollTop = Math.min(
      state.scrollTop,
      Math.max(0, state.contentHeight - state.viewportHeight),
    );
    scrollEvent();
  };

  const contentChanged = () => {
    act(() => {
      reportContentHeightChanged?.();
    });
  };

  return {
    el,
    get scrollTop() {
      return state.scrollTop;
    },
    distanceFromBottom() {
      return Math.max(0, state.contentHeight - state.scrollTop - state.viewportHeight);
    },
    grow(px) {
      state.contentHeight += px;
      contentChanged();
    },
    shrinkContent(px) {
      state.contentHeight -= px;
      clampAfterShrink();
      contentChanged();
    },
    growViewport(px) {
      state.viewportHeight += px;
      clampAfterShrink();
      fireResizeObservers();
    },
    shrinkViewport(px) {
      state.viewportHeight -= px;
      fireResizeObservers();
    },
    readerScrollsUp(px) {
      wheelBy(px);
    },
    wheelInput(px) {
      act(() => {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -px }));
      });
    },
    touchStart(clientY) {
      act(() => {
        el.dispatchEvent(touchEvent("touchstart", clientY));
      });
    },
    touchMove(clientY, scrollPx) {
      act(() => {
        el.dispatchEvent(touchEvent("touchmove", clientY));
      });
      state.scrollTop -= scrollPx;
      scrollEvent();
    },
    touchEnd() {
      act(() => {
        el.dispatchEvent(touchEvent("touchend"));
      });
    },
    touchMomentumScrollsUp(px) {
      state.scrollTop -= px;
      scrollEvent();
    },
    readerScrollsTo(fromBottom) {
      wheelBy(fromBottom - this.distanceFromBottom());
    },
    wheelWithoutScroll(px) {
      const nested = document.createElement("pre");
      el.appendChild(nested);
      act(() => {
        nested.dispatchEvent(new WheelEvent("wheel", { deltaY: -px, bubbles: true }));
      });
    },
    pageUpFromRowControl() {
      const control = document.createElement("button");
      el.appendChild(control);
      act(() => {
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
      });
    },
    shiftSpaceFromRowControl() {
      const control = document.createElement("button");
      el.appendChild(control);
      act(() => {
        control.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }),
        );
      });
    },
    browserScrollsListUp(px) {
      state.scrollTop -= px;
      scrollEvent();
    },
  };
}

function taskMsg(seq: number, content: string): TaskMessagePayload {
  return { task_id: TASK_ID, seq, type: "text", content } as TaskMessagePayload;
}

const RUNNING_TASK = { task_id: TASK_ID, status: "running" } as const;

function renderChat({
  contentHeight = 2000,
  pendingTask = RUNNING_TASK as typeof RUNNING_TASK | null,
} = {}) {
  const qc = new QueryClient();
  qc.setQueryData(chatKeys.taskMessages(TASK_ID), [taskMsg(0, "Looking into it. ")]);

  const ui = (pending: typeof RUNNING_TASK | null) => (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        <ChatMessageList messages={[]} pendingTask={pending} availability={undefined} />
      </QueryClientProvider>
    </I18nProvider>
  );

  const view = render(ui(pendingTask));

  const el = view.container.querySelector<HTMLElement>("[data-tab-scroll-root]");
  if (!el) throw new Error("chat list did not render a scroll container");

  return {
    qc,
    view,
    scroll: scroller(el, contentHeight),
    rowCount: () => view.container.querySelectorAll("[data-row-key]").length,
    followsAtBottom: () =>
      view.container
        .querySelector("[data-follow-at-bottom]")
        ?.getAttribute("data-follow-at-bottom"),
    setPendingTask: (pending: typeof RUNNING_TASK | null) => {
      act(() => {
        view.rerender(ui(pending));
      });
    },
    streamChunk: (seq: number) => {
      act(() => {
        qc.setQueryData<TaskMessagePayload[]>(
          chatKeys.taskMessages(TASK_ID),
          (old = []) => [...old, taskMsg(seq, `chunk ${seq} `)],
        );
      });
    },
  };
}

const renderIdleChat = ({ contentHeight = 2000 } = {}) =>
  renderChat({ contentHeight, pendingTask: null });

describe("ChatMessageList auto-scroll", () => {
  it("follows a streaming reply whose row count never changes", () => {
    const { scroll, streamChunk, rowCount } = renderChat();

    const rowsBefore = rowCount();
    for (let seq = 1; seq <= 30; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(rowCount()).toBe(rowsBefore);
    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("keeps the newest content clear of a composer that grew", () => {
    const { scroll } = renderChat();

    scroll.shrinkViewport(72);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("stays pinned when the composer collapses", () => {
    const { scroll, streamChunk } = renderChat();

    streamChunk(1);
    scroll.grow(180);
    scroll.growViewport(72);

    for (let seq = 2; seq <= 3; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("stays pinned when content shrinks", () => {
    const { scroll, streamChunk } = renderChat();

    streamChunk(1);
    scroll.grow(180);
    scroll.shrinkContent(400);

    for (let seq = 2; seq <= 3; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // The base behavior `atBottomThreshold` always granted: a trackpad nudge
  // inside the edge zone is not the reader leaving.
  it("keeps following after a small trackpad nudge near the live end", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.readerScrollsUp(2);
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("releases when touch momentum carries a flick past the threshold", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.touchStart(100);
    scroll.touchMove(180, 80);
    scroll.touchEnd();
    scroll.touchMomentumScrollsUp(80);
    const parked = scroll.scrollTop;

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  it("leaves a fractional touch drag in progress", () => {
    const { scroll, streamChunk, followsAtBottom } = renderChat();

    scroll.touchStart(100);
    scroll.touchMove(180, 80.5);
    streamChunk(1);

    expect(scroll.distanceFromBottom()).toBe(80.5);
    expect(followsAtBottom()).toBe("auto");
    scroll.touchEnd();
  });

  it("resumes pinning after a sub-threshold touch ends", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.touchStart(100);
    scroll.touchMove(180, 80);
    scroll.touchEnd();
    gestureSettles();
    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("releases on incremental upward scrolling during a fast stream", () => {
    const { scroll, streamChunk } = renderChat();

    streamChunk(1);
    scroll.grow(180);

    // 60px wheel ticks, each under the edge threshold on its own and each
    // answered by a chunk that pins the reader back — but the displacement
    // they actually took accumulates across the pins, so the third tick
    // crosses the threshold and releases.
    for (let seq = 2; seq <= 5; seq++) {
      scroll.readerScrollsUp(60);
      streamChunk(seq);
      scroll.grow(180);
    }
    gestureSettles();
    streamChunk(6);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(660);
  });

  // Discrete mouse wheel at reading pace: one notch per event, spaced past
  // the intent window. Release must not require a single fast burst.
  it("releases for wheel notches spaced past the intent window", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.readerScrollsUp(100);
    gestureSettles();
    scroll.readerScrollsUp(100);
    gestureSettles();
    const parked = scroll.scrollTop;

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  // A reply's final chunk always exists and has a whole intent window to land
  // in after any small nudge; no later event will re-evaluate a declined pin.
  it("pins a chunk that lands inside the reader's intent window", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.readerScrollsUp(2);
    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("honors Shift+Space paging from a focused row control", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.shiftSpaceFromRowControl();
    scroll.browserScrollsListUp(VIEWPORT);
    const parked = scroll.scrollTop;
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  it("leaves the viewport alone once the reader scrolls up to read history", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.readerScrollsTo(900);
    gestureSettles();
    const parked = scroll.scrollTop;

    streamChunk(1);
    scroll.grow(500);
    scroll.shrinkViewport(72);

    expect(scroll.scrollTop).toBe(parked);
  });

  // Wheel over a capped code block scrolls the block; the event bubbles to
  // the list without moving it. Unconsumed input must not release the follow.
  it("keeps following through wheel input the list never consumed", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.wheelWithoutScroll(200);
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("pins a system shift after nested scrolling left input unconsumed", () => {
    const { scroll } = renderChat();

    scroll.wheelWithoutScroll(300);
    renderFrame();
    scroll.browserScrollsListUp(200);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // A mouse wheel tick delivers its input at once; the browser ANIMATES the
  // scroll over the following frames. A pin landing mid-animation cancels the
  // animation and reverts the tick, so wheel users were yanked back to the
  // bottom continuously — every tick answered by a chunk or one of Virtuoso's
  // re-measure height changes — while touchpads, whose displacement confirms
  // per event, escaped normally (TIM-65 follow-up).
  it("does not cancel an animated wheel tick with a mid-flight chunk pin", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.wheelInput(100);
    scroll.browserScrollsListUp(10); // first animation frame confirms the tick
    streamChunk(1);
    scroll.grow(180); // chunk lands mid-animation: must not pin

    expect(scroll.distanceFromBottom()).toBe(190);
  });

  it("releases across two animated wheel ticks despite growth between them", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.wheelInput(100);
    scroll.browserScrollsListUp(20);
    streamChunk(1);
    scroll.grow(180); // deferred: the tick's animation is still in flight
    scroll.browserScrollsListUp(80); // tick 1 finishes: 100px taken
    scroll.wheelInput(100);
    scroll.browserScrollsListUp(100); // tick 2: 200px taken, released
    gestureSettles();
    streamChunk(2);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(560);
  });

  // The frame-boundary re-judge fires only for pins a gesture actually
  // deferred. An unconditional re-judge snapped back every sub-threshold
  // reader scroll (touchpad tick, arrow key) one frame later, with no growth
  // anywhere (TIM-65 review).
  it("leaves a confirmed sub-threshold scroll alone at the frame boundary", () => {
    const { scroll } = renderChat();

    scroll.readerScrollsUp(60);
    expect(scroll.distanceFromBottom()).toBe(60);

    renderFrame();

    expect(scroll.distanceFromBottom()).toBe(60);
  });

  it("pins growth deferred by unconsumed input once the claim frame ends", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.wheelWithoutScroll(300);
    streamChunk(1);
    scroll.grow(180); // deferred: the claim might still confirm

    expect(scroll.distanceFromBottom()).toBe(180);

    renderFrame(); // claim discarded at the frame boundary: deferred pin fires

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // A deferral with no input frame left to consume it (growth deferred by
  // carry residue after the gesture's rAF already fired) must be settled by
  // the pin that eventually resolves it — not inherited by the next gesture's
  // frame boundary, which would snap back a scroll that gesture never earned
  // (TIM-65 review round 2).
  it("does not inherit a stranded deferral into a later gesture's frame", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.wheelInput(100);
    scroll.browserScrollsListUp(40); // browser under-delivers: carry residue
    renderFrame(); // this gesture's boundary: nothing deferred yet

    streamChunk(1);
    scroll.grow(180); // deferred by the residue

    gestureSettles();
    streamChunk(2);
    scroll.grow(180); // settle window over: pins normally, settling the flag
    expect(scroll.distanceFromBottom()).toBe(0);

    gestureSettles();
    scroll.readerScrollsUp(60); // brand new, fully confirmed, sub-threshold
    expect(scroll.distanceFromBottom()).toBe(60);

    renderFrame(); // nothing deferred this frame: nothing to re-judge

    expect(scroll.distanceFromBottom()).toBe(60);
  });

  it("keeps following after a flick on a conversation too short to scroll", () => {
    const { scroll, streamChunk } = renderChat({ contentHeight: 400 });

    scroll.wheelWithoutScroll(200);
    gestureSettles();

    for (let seq = 1; seq <= 8; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // Focus sits on a row control, the reader presses PageUp, and the browser
  // scrolls the list. The scroll confirms the staged key intent: the reader
  // is released, not pinned back over their own keypress.
  it("honors keyboard paging from a focused row control", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.pageUpFromRowControl();
    scroll.browserScrollsListUp(VIEWPORT);
    const parked = scroll.scrollTop;
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  it("re-engages when the reader scrolls back down to the live end", () => {
    const { scroll, streamChunk } = renderChat();

    scroll.readerScrollsTo(900);
    scroll.readerScrollsTo(0);
    gestureSettles();

    streamChunk(1);
    scroll.grow(500);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // `followOutput` is `atBottom && isFollowing()`: a released follow must turn
  // it off even while Virtuoso still reports the reader at the bottom.
  it("turns followOutput off while released, even when Virtuoso reports atBottom", () => {
    const { scroll, streamChunk, followsAtBottom } = renderChat();

    expect(followsAtBottom()).toBe("auto");

    scroll.readerScrollsTo(900);
    streamChunk(1);

    expect(followsAtBottom()).toBe("false");
  });

  it("stops measuring once the list unmounts", () => {
    const { view } = renderChat();

    view.unmount();

    expect(observedTargets()).toHaveLength(0);
  });
});

// With no task in flight there is no live end: nothing may move the viewport
// on the reader's behalf, whatever resizes or scrolls happen (TIM-65).
describe("ChatMessageList auto-scroll while idle", () => {
  it("does not pin when content grows under a reader at the bottom", () => {
    const { scroll } = renderIdleChat();

    scroll.grow(400);

    expect(scroll.distanceFromBottom()).toBe(400);
  });

  it("does not pin when the composer grows", () => {
    const { scroll } = renderIdleChat();

    scroll.shrinkViewport(72);

    expect(scroll.distanceFromBottom()).toBe(72);
  });

  it("does not fight a scroll it saw no input for", () => {
    const { scroll } = renderIdleChat();

    scroll.browserScrollsListUp(300);

    expect(scroll.distanceFromBottom()).toBe(300);
  });

  it("still follows appended rows through plain atBottom", () => {
    const { followsAtBottom } = renderIdleChat();

    expect(followsAtBottom()).toBe("auto");
  });

  it("engages the follow when a task starts with the reader at the bottom", () => {
    const { scroll, setPendingTask, streamChunk } = renderIdleChat();

    setPendingTask(RUNNING_TASK);
    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("leaves a reader up in history alone when a task starts", () => {
    const { scroll, setPendingTask, streamChunk } = renderIdleChat();

    scroll.browserScrollsListUp(900);
    const parked = scroll.scrollTop;

    setPendingTask(RUNNING_TASK);
    streamChunk(1);
    scroll.grow(500);

    expect(scroll.scrollTop).toBe(parked);
  });
});

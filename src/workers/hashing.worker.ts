import {
  HashState,
  type HashRequest,
  type HashReply,
} from "../radio/hashingState";
const state = new HashState();
self.onmessage = (event: MessageEvent<HashRequest>) => {
  try {
    self.postMessage(state.process(event.data));
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    } satisfies HashReply);
  }
};

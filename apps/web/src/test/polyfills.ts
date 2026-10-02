// jsdom has no EventSource. A no-op stub lets MSW build its SSE handlers and keeps live streams silent.
class EventSourceStub {
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { KeyReader } from "../src/keys.js";

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
  }
  setRawMode() {}
  resume() {}
  pause() {}
}

const quietStdout = { write() {} };

function makeReader() {
  const stdin = new FakeStdin();
  const reader = new KeyReader(stdin, { kitty: true, stdout: quietStdout });
  reader.detecting = false;
  const events = [];
  for (const name of ["space", "shift", "modifier", "enter", "escape", "up", "down", "char", "ctrl-c", "paste"]) {
    reader.on(name, (payload) => events.push({ name, ...payload }));
  }
  return { reader, events, stdin };
}

const feed = (reader, text) => reader._feed(Buffer.from(text, "latin1"));

test("legacy space, characters, arrows and paste", async () => {
  const { reader, events } = makeReader();
  feed(reader, " ");
  feed(reader, "q");
  feed(reader, "\x1b[A");
  feed(reader, "\x1b[1;2B");
  feed(reader, "\x1b[200~this should be swallowed\x1b[201~");

  assert.equal(events[0].name, "space");
  assert.equal(events[0].event, 1);
  assert.equal(events[1].name, "char");
  assert.equal(events[1].value, "q");
  assert.equal(events[2].name, "up");
  assert.equal(events[3].name, "down");
  assert.equal(events[4].name, "paste");
  assert.match(events[4].text, /swallowed/);
  assert.equal(events.filter((event) => event.name === "char").length, 1);
  reader.destroy();
});

test("a lone escape is reported after the ambiguity window", async () => {
  const { reader, events } = makeReader();
  feed(reader, "\x1b");
  assert.equal(events.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "escape");
  reader.destroy();
});

test("kitty shift press and release", () => {
  const { reader, events } = makeReader();
  feed(reader, "\x1b[57441;2:1u");
  feed(reader, "\x1b[57441;2:2u");
  feed(reader, "\x1b[57441;1:3u");

  assert.equal(events[0].name, "shift");
  assert.equal(events[0].event, 1);
  assert.equal(events[0].side, "left");
  assert.equal(events[0].mods.shift, true);
  // Repeats of modifier keys are ignored.
  assert.equal(events[1].name, "shift");
  assert.equal(events[1].event, 3);
  assert.equal(events.length, 2);
  reader.destroy();
});

test("kitty text, shifted text and space", () => {
  const { reader, events } = makeReader();
  feed(reader, "\x1b[113;1:1;113u"); // q
  feed(reader, "\x1b[47;2:1;63u"); // ? (shift + slash, text “?”)
  feed(reader, "\x1b[32;1:1;32u");
  feed(reader, "\x1b[32;1:3;32u");

  assert.deepEqual(
    events.map((event) => [event.name, event.value ?? event.event]),
    [
      ["char", "q"],
      ["char", "?"],
      ["space", 1],
      ["space", 3],
    ]
  );
  assert.equal(events[1].mods.shift, true);
  reader.destroy();
});

test("kitty ctrl-c and arrow functions", () => {
  const { reader, events } = makeReader();
  feed(reader, "\x1b[99;5:1u");
  feed(reader, "\x1b[1;5A");
  feed(reader, "\x1b[1;1:3A"); // release: must not become another arrow press
  assert.equal(events[0].name, "ctrl-c");
  assert.equal(events[1].name, "up");
  assert.equal(events.length, 2);
  reader.destroy();
});

test("enter and escape in both encodings", () => {
  const { reader, events } = makeReader();
  feed(reader, "\r");
  feed(reader, "\x1b[13;1:1u");
  feed(reader, "\x1b[13;1:3u");
  feed(reader, "\x1b[27;1:1u");
  feed(reader, "\x1b[27;1:3u");
  assert.deepEqual(
    events.map((event) => event.name),
    ["enter", "enter", "escape"]
  );
  reader.destroy();
});

test("kitty protocol detection answers the query", async () => {
  const stdin = new FakeStdin();
  const reader = new KeyReader(stdin, { kitty: true, stdout: quietStdout });
  const supported = reader._detectKitty();
  reader._feed(Buffer.from("\x1b[?1u", "latin1"));
  assert.equal(await supported, true);
  reader.destroy();
});

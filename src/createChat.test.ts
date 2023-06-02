import { strict as assert } from "node:assert";
import {test, mock} from "node:test";
import { createChat } from "./createChat";

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must be set");
}

test("sends a message and receives a response", async () => {
  const chat = createChat({
    apiKey: OPENAI_API_KEY,
    model: "gpt-3.5-turbo",
  });

  const response = await chat.sendMessage('respond with "pong"');

  assert.match(response.content, /pong/i);
});

test("remembers conversation", async () => {
  const chat = createChat({
    apiKey: OPENAI_API_KEY,
    model: 'gpt-3.5-turbo'
  });

  await chat.sendMessage('remember number 14159265359');

  const response = await chat.sendMessage('what number did I say?');

  assert.match(response.content, /14159265359/);
});

test("streams progress", async () => {
  const chat = createChat({
    apiKey: OPENAI_API_KEY,
    model: 'gpt-3.5-turbo'
  });

  const onMessage = mock.fn((message) => {
    console.log(message);
  });

  await chat.sendMessage('continue sequence: foo bar baz', onMessage);

  assert.ok(onMessage.mock.calls.length > 0);
});
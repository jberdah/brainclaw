import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToml, escapeTomlString, tomlArrayTableHasEntry } from '../../src/core/toml-writer.js';

describe('toml-writer', () => {
  describe('escapeTomlString', () => {
    it('escapes backslash, quote, newline, carriage return, tab', () => {
      assert.equal(escapeTomlString('a\\b"c\nd\re\tf'), 'a\\\\b\\"c\\nd\\re\\tf');
    });

    it('passes through plain ASCII', () => {
      assert.equal(escapeTomlString('hello world 42'), 'hello world 42');
    });
  });

  describe('renderToml — single inline table', () => {
    it('writes `[name]` with key=value pairs and trailing newline', () => {
      const out = renderToml({
        tables: [{ name: 'general', entries: { model: 'medium-3.5', endpoint: 'https://api.mistral.ai' } }],
      });
      assert.equal(
        out,
        '[general]\nmodel = "medium-3.5"\nendpoint = "https://api.mistral.ai"\n',
      );
    });
  });

  describe('renderToml — array-of-tables', () => {
    it('writes `[[name]]` blocks for each entry', () => {
      const out = renderToml({
        arrayTables: [{
          name: 'mcp_servers',
          entries: [
            { name: 'brainclaw', transport: 'stdio', command: 'npx' },
            { name: 'serena', transport: 'http' },
          ],
        }],
      });
      assert.equal(
        out,
        '[[mcp_servers]]\nname = "brainclaw"\ntransport = "stdio"\ncommand = "npx"\n\n' +
        '[[mcp_servers]]\nname = "serena"\ntransport = "http"\n',
      );
    });

    it('serializes string-array values as inline arrays', () => {
      const out = renderToml({
        arrayTables: [{
          name: 'mcp_servers',
          entries: [{ name: 'brainclaw', args: ['-y', 'brainclaw@latest', 'mcp'] }],
        }],
      });
      assert.match(out, /args = \["-y", "brainclaw@latest", "mcp"\]/);
    });

    it('escapes embedded quotes in string values', () => {
      const out = renderToml({
        arrayTables: [{ name: 'x', entries: [{ note: 'has "quotes"' }] }],
      });
      assert.match(out, /note = "has \\"quotes\\""/);
    });
  });

  describe('renderToml — empty doc', () => {
    it('returns empty string when no tables or arrayTables', () => {
      assert.equal(renderToml({}), '');
    });
  });

  describe('tomlArrayTableHasEntry', () => {
    const sample = `
[[mcp_servers]]
name = "brainclaw"
transport = "stdio"
command = "npx"

[[mcp_servers]]
name = "serena"
transport = "http"
`.trim();

    it('finds an existing entry by section + name field', () => {
      assert.equal(tomlArrayTableHasEntry(sample, 'mcp_servers', 'brainclaw'), true);
      assert.equal(tomlArrayTableHasEntry(sample, 'mcp_servers', 'serena'), true);
    });

    it('returns false when section is absent', () => {
      assert.equal(tomlArrayTableHasEntry(sample, 'tools', 'brainclaw'), false);
    });

    it('returns false when entry name does not match', () => {
      assert.equal(tomlArrayTableHasEntry(sample, 'mcp_servers', 'unknown'), false);
    });
  });
});

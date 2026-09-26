'use strict';

/*
 * The recursive Mach-O closure check for the owned ttyd runtime (#1245, ADR
 * 0018 §3): the runtime may load only macOS system libraries and its own
 * private bundle, judged over the WHOLE load graph. Driven from otool fixtures
 * so every rule runs on every CI host.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOtoolL, parseRpaths, verifyClosure } = require('../lib/macho-closure');

const BUNDLE = '/Users/op/.tangleclaw/bin';
const EXE = `${BUNDLE}/ttyd`;

/**
 * `otool -L` output for an image.
 * @param {string} image - The image path otool prints first.
 * @param {string[]} deps - Install names.
 * @returns {string}
 */
function otoolL(image, deps) {
  return `${image}:\n` + deps.map((d) => `\t${d} (compatibility version 1.0.0, current version 1.0.0)`).join('\n') + '\n';
}

/**
 * `otool -l` output carrying the given LC_RPATH entries.
 * @param {string[]} rpaths
 * @returns {string}
 */
function otoolRpaths(rpaths) {
  return rpaths.map((r) => `Load command 20\n          cmd LC_RPATH\n      cmdsize 32\n         path ${r} (offset 12)\n`).join('');
}

/**
 * Build the injected probes from a map of image → {deps, rpaths, id}.
 * @param {object} images
 * @returns {object}
 */
function probes(images) {
  return {
    bundleDir: BUNDLE,
    otoolL: (img) => {
      if (!images[img]) throw new Error(`no such image ${img}`);
      const own = images[img].id ? [images[img].id] : [];
      return otoolL(img, [...own, ...images[img].deps]);
    },
    otooll: (img) => otoolRpaths((images[img] && images[img].rpaths) || []),
    dylibId: (img) => (images[img] && images[img].id) || null,
    exists: (p) => Object.prototype.hasOwnProperty.call(images, p)
  };
}

const SYSTEM = ['/usr/lib/libz.1.dylib', '/usr/lib/libutil.dylib', '/usr/lib/libSystem.B.dylib'];

describe('lib/macho-closure (#1245, ADR 0018)', () => {
  describe('parsers', () => {
    it('reads dependency install names, dropping a dylib\'s own install name', () => {
      const text = otoolL('/x/libfoo.dylib', ['@rpath/libfoo.dylib', '/usr/lib/libSystem.B.dylib']);
      assert.deepEqual(parseOtoolL(text, '@rpath/libfoo.dylib'), ['/usr/lib/libSystem.B.dylib']);
      assert.deepEqual(parseOtoolL(text), ['@rpath/libfoo.dylib', '/usr/lib/libSystem.B.dylib']);
    });

    it('reads LC_RPATH entries and nothing else', () => {
      const text = 'Load command 1\n      cmd LC_LOAD_DYLIB\n name /usr/lib/x (offset 24)\n' + otoolRpaths(['@loader_path/../lib', '/opt/homebrew/lib']);
      assert.deepEqual(parseRpaths(text), ['@loader_path/../lib', '/opt/homebrew/lib']);
    });
  });

  describe('verifyClosure', () => {
    it('accepts a statically linked runtime that loads only system libraries (the shipped shape)', () => {
      const r = verifyClosure(EXE, probes({ [EXE]: { deps: SYSTEM } }));
      assert.equal(r.ok, true, JSON.stringify(r.violations));
      assert.equal(r.graph.length, 1, 'system images are not descended');
    });

    it('refuses the Homebrew-linked scratch binary\'s shape', () => {
      const r = verifyClosure(EXE, probes({ [EXE]: { deps: [...SYSTEM, '/opt/homebrew/opt/libwebsockets/lib/libwebsockets.21.dylib'] } }));
      assert.equal(r.ok, false);
      assert.match(r.violations[0].reason, /absolute path outside the macOS system roots/);
    });

    for (const bad of ['/usr/local/lib/libuv.1.dylib', '/opt/local/lib/libjson-c.5.dylib', '/tmp/tcc-build/lib/libx.dylib', '/opt/homebrew/Cellar/ttyd/1.7.7_6/lib/x.dylib']) {
      it(`refuses ${bad}`, () => {
        assert.equal(verifyClosure(EXE, probes({ [EXE]: { deps: [bad] } })).ok, false);
      });
    }

    // THE CASE A SHALLOW CHECK MISSES: the main binary looks clean, and a private
    // library it loads points back into Homebrew.
    it('walks into a private bundle library and refuses what IT loads', () => {
      const lib = `${BUNDLE}/lib/libwebsockets.dylib`;
      const r = verifyClosure(EXE, probes({
        [EXE]: { deps: [...SYSTEM, '@rpath/libwebsockets.dylib'], rpaths: ['@executable_path/lib'] },
        [lib]: { id: '@rpath/libwebsockets.dylib', deps: ['/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'] }
      }));
      assert.equal(r.ok, false);
      assert.equal(r.violations[0].image, lib);
      assert.equal(r.graph.length, 2);
    });

    it('accepts a private bundle whose libraries load only system libraries and each other', () => {
      const lws = `${BUNDLE}/lib/libwebsockets.dylib`;
      const uv = `${BUNDLE}/lib/libuv.dylib`;
      const r = verifyClosure(EXE, probes({
        [EXE]: { deps: [...SYSTEM, '@rpath/libwebsockets.dylib'], rpaths: ['@executable_path/lib'] },
        [lws]: { id: '@rpath/libwebsockets.dylib', deps: ['@loader_path/libuv.dylib', '/usr/lib/libSystem.B.dylib'] },
        [uv]: { id: '@rpath/libuv.dylib', deps: ['/usr/lib/libSystem.B.dylib'] }
      }));
      assert.equal(r.ok, true, JSON.stringify(r.violations));
      assert.equal(r.graph.length, 3);
    });

    it('refuses an rpath that points outside the bundle, even if nothing uses it yet', () => {
      const r = verifyClosure(EXE, probes({ [EXE]: { deps: SYSTEM, rpaths: ['/opt/homebrew/lib'] } }));
      assert.equal(r.ok, false);
      assert.match(r.violations[0].reason, /LC_RPATH points outside/);
    });

    it('refuses an @rpath reference that no in-bundle rpath resolves', () => {
      const r = verifyClosure(EXE, probes({ [EXE]: { deps: ['@rpath/libuv.dylib'], rpaths: [] } }));
      assert.equal(r.ok, false);
      assert.match(r.violations[0].reason, /no rpath inside the bundle resolves/);
    });

    it('refuses a @loader_path reference that climbs out of the bundle', () => {
      const r = verifyClosure(EXE, probes({ [EXE]: { deps: ['@loader_path/../../outside/libx.dylib'] } }));
      assert.equal(r.ok, false);
      assert.match(r.violations[0].reason, /resolves outside the private bundle/);
    });

    it('refuses a reference to a missing file inside the bundle', () => {
      const r = verifyClosure(EXE, probes({ [EXE]: { deps: ['@executable_path/lib/gone.dylib'] } }));
      assert.equal(r.ok, false);
      assert.match(r.violations[0].reason, /missing file/);
    });

    it('reports an image it could not read as a violation, never as clean', () => {
      const r = verifyClosure('/nowhere/ttyd', { ...probes({}), bundleDir: '/nowhere' });
      assert.equal(r.ok, false);
      assert.match(r.violations[0].reason, /could not read the image/);
    });

    it('terminates on a dependency cycle inside the bundle', () => {
      const a = `${BUNDLE}/lib/a.dylib`;
      const b = `${BUNDLE}/lib/b.dylib`;
      const r = verifyClosure(EXE, probes({
        [EXE]: { deps: ['@executable_path/lib/a.dylib'] },
        [a]: { id: a, deps: ['@loader_path/b.dylib'] },
        [b]: { id: b, deps: ['@loader_path/a.dylib'] }
      }));
      assert.equal(r.ok, true);
      assert.equal(r.graph.length, 3);
    });
  });
});

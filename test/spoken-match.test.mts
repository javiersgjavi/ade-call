import test from 'node:test';
import assert from 'node:assert/strict';
import { nameIndex, spokenMatch, spokenWords } from '../src/shared/spoken-match.mjs';

const kind = (query: string | string[], name: string, context?: string) => spokenMatch(query, name, undefined, context)?.kind ?? null;

test('written forms match regardless of accents, spacing, spelled digits and function words', () => {
  assert.deepEqual(spokenWords('Migración: Árbol v-DOS'), ['migracion', 'arbol', 'v2']);
  assert.deepEqual(spokenWords('te tres, ti three, ka 8 ese, de 2 a 3'), ['t3', 't3', 'k8', 'ese', 'd2', 'a3']);
  for (const [query, name] of [['decision arbol', 'Árbol de DECISIÓN'], ['lighthouse', 'Light house bridge'], ['light house', 'LightHouse bridge'],
    ['a tarazana web', 'atarazana-web'], ['uve dos api', 'V2 API'], ['te tres light house', 'T3 light house'], ['whisper en el nas', 'Usar Whisper en NAS'], ['eleven labs', 'Explorar ElevenLabs']])
    assert.equal(kind(query, name), 'words', query);
});

test('small slips become approximate candidates; pronunciations and spelled acronyms need written variants', () => {
  for (const [query, name] of [['open telemetri', 'OpenTelemetry export'], ['kubernetis cluster', 'Kubernetes cluster'],
    ['light hause', 'light-house bridge'], ['elevenlaps proveedor', 'Explorar ElevenLabs como proveedor']]) {
    const match = spokenMatch(query, name);
    assert.equal(match?.kind, 'approximate', query); assert.ok(match.score >= 0.75 && match.score < 1, query);
  }
  for (const [spoken, written, name] of [['guisper nas', 'Whisper NAS', 'Usar Whisper en NAS'], ['uve ele consultancy', 'vl consultancy', 'vl-consultancy']]) {
    assert.equal(spokenMatch(spoken, name), null, spoken);
    assert.equal(spokenMatch([spoken, written], name)?.variant, written, spoken);
  }
});

test('unrelated or partial names do not match; rare words outweigh common ones', () => {
  for (const [query, name] of [['industrial agent', 'Integración light-house'], ['abcd', 'abce tracker'], ['billing', 'Logging pipeline'],
    ['elevenlabs xyz', 'Explorar ElevenLabs'], ['base de datos', 'Exportar datos'], ['de el la', 'Plan de la semana'], ['qué tal va eso', 'Guía de instalación'], ['tal', 'sedelsur-catalogo']])
    assert.equal(spokenMatch(query, name), null, query);
  const index = nameIndex(['Revisar plan de pruebas', 'Plan de despliegue', 'Plan de marketing', 'Plan de ventas']);
  assert.equal(spokenMatch('plan pruebas', 'Plan de ventas', index), null);
  assert.equal(spokenMatch('plan pruebas', 'Revisar plan de pruebas', index)?.kind, 'words');
  // "proyecto" describes the request: it must not pick one title among namesakes.
  const named = nameIndex(['ENCE · integración del proyecto', 'ENCE · revisión de datos', 'ENCE · correo']);
  for (const title of ['ENCE · revisión de datos', 'ENCE · correo', 'ENCE · integración del proyecto'])
    assert.equal(spokenMatch('el proyecto de ence', title, named)?.kind, 'words', title);
});

test('project names complete a title but never match a thread alone; variants report what matched', () => {
  assert.equal(kind('elevenlabs light house', 'Explorar ElevenLabs', 'light-house'), 'words');
  assert.equal(kind('light house', 'Explorar ElevenLabs', 'light-house'), null);
  const match = spokenMatch(['la guía de instalación', 'onboarding'], 'Crear guía de onboarding');
  assert.equal(match?.kind, 'words'); assert.equal(match.variant, 'onboarding');
  assert.equal(spokenMatch(['zzz', 'qqq'], 'Crear guía'), null);
});

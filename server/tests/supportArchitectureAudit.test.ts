import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverRoot = path.resolve(import.meta.dirname, '..');
const gatewaySource = readFileSync(path.join(serverRoot, 'services/agents/pipeline/ChannelGateway.ts'), 'utf8').replace(/\r\n/g, '\n');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const availability = '    new AssistantAvailabilityStage(),\n';

interface AuditReport {
  stages: string[];
  stageDrift: boolean;
  quarantinedLegacyCandidates: Array<{ candidate: string; unexpected: string[] }>;
  trackedGeneratedArtifacts: string[];
}

describe('support architecture audit command', () => {
  let fixtureRoot: string;
  let fixtureServer: string;

  function writeFixture(relative: string, contents: string): void {
    const absolute = path.join(fixtureServer, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  function runAudit(source = gatewaySource): { status: number | null; report: AuditReport } {
    writeFixture('services/agents/pipeline/ChannelGateway.ts', source);
    const result = spawnSync(process.execPath, [tsxCli, path.join(fixtureServer, 'scripts/audit-support-architecture.ts')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    if (!result.stdout.trim()) throw new Error(`Audit did not produce JSON: ${result.stderr}`);
    return { status: result.status, report: JSON.parse(result.stdout) as AuditReport };
  }

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'asksales-as022-audit-'));
    writeFileSync(path.join(fixtureRoot, 'package.json'), '{"type":"module"}');
    fixtureServer = path.join(fixtureRoot, 'server');
    mkdirSync(path.join(fixtureServer, 'scripts'), { recursive: true });
    copyFileSync(path.join(serverRoot, 'scripts/audit-support-architecture.ts'), path.join(fixtureServer, 'scripts/audit-support-architecture.ts'));
    const git = spawnSync('git', ['init', '--quiet'], { cwd: fixtureRoot, encoding: 'utf8' });
    expect(git.status).toBe(0);
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('accepts the shipped pipeline with availability between inbound safety and playbook selection', () => {
    const { status, report } = runAudit();
    expect(status).toBe(0);
    expect(report.stageDrift).toBe(false);
    const position = report.stages.indexOf('AssistantAvailabilityStage');
    // Handoff consent resolves a pending human-handoff offer before any
    // playbook is selected, so it sits between availability and selection.
    expect(report.stages.slice(position - 1, position + 3)).toEqual([
      'InboundGuardrailStage', 'AssistantAvailabilityStage', 'HandoffConsentStage', 'ActivePlaybookSelectionStage',
    ]);
    expect(report.stages.filter(stage => stage === 'AssistantAvailabilityStage')).toHaveLength(1);
  });

  it('rejects removal of assistant availability', () => {
    const { status, report } = runAudit(gatewaySource.replace(availability, ''));
    expect(status).toBe(1);
    expect(report.stageDrift).toBe(true);
    expect(report.stages).not.toContain('AssistantAvailabilityStage');
  });

  it.each(['PrivacyStage', 'InboundGuardrailStage'])(
    'rejects availability before the mandatory %s',
    stage => {
      const source = gatewaySource.replace(availability, '').replace(`    new ${stage}(),`, `${availability}    new ${stage}(),`);
      const { status, report } = runAudit(source);
      expect(report.stages.indexOf('AssistantAvailabilityStage')).toBeLessThan(report.stages.indexOf(stage));
      expect(status).toBe(1);
      expect(report.stageDrift).toBe(true);
    },
  );

  it.each(['ActivePlaybookSelectionStage', 'AgentDispatchStage'])(
    'rejects availability delayed until after %s',
    stage => {
      const source = gatewaySource.replace(availability, '').replace(`    new ${stage}(),\n`, `    new ${stage}(),\n${availability}`);
      const { status, report } = runAudit(source);
      expect(report.stages.indexOf('AssistantAvailabilityStage')).toBeGreaterThan(report.stages.indexOf(stage));
      expect(status).toBe(1);
      expect(report.stageDrift).toBe(true);
    },
  );

  it('rejects duplicate availability stages', () => {
    const { status, report } = runAudit(gatewaySource.replace(availability, availability.repeat(2)));
    expect(report.stages.filter(stage => stage === 'AssistantAvailabilityStage')).toHaveLength(2);
    expect(status).toBe(1);
    expect(report.stageDrift).toBe(true);
  });

  it('rejects unexpected stages', () => {
    const { status, report } = runAudit(gatewaySource.replace(availability, `${availability}    new UnexpectedStage(),\n`));
    expect(report.stages).toContain('UnexpectedStage');
    expect(status).toBe(1);
    expect(report.stageDrift).toBe(true);
  });

  it('rejects a missing confidence gate', () => {
    const { status, report } = runAudit(gatewaySource.replace('    new ConfidenceGate(),\n', ''));
    expect(report.stages).not.toContain('ConfidenceGate');
    expect(status).toBe(1);
    expect(report.stageDrift).toBe(true);
  });

  it('rejects delivery moved ahead of its decision audit', () => {
    const source = gatewaySource.replace(
      '    new DecisionAuditStage(),\n    new DeliveryStage(),',
      '    new DeliveryStage(),\n    new DecisionAuditStage(),',
    );
    const { status, report } = runAudit(source);
    expect(report.stages.indexOf('DeliveryStage')).toBeLessThan(report.stages.indexOf('DecisionAuditStage'));
    expect(status).toBe(1);
    expect(report.stageDrift).toBe(true);
  });

  it('ignores separately invoked recovery stages outside the ordered declaration', () => {
    const { status, report } = runAudit(`${gatewaySource}\nnew RecoveryStage();\nnew AssistantAvailabilityStage();\n`);
    expect(report.stages).not.toContain('RecoveryStage');
    expect(report.stages.filter(stage => stage === 'AssistantAvailabilityStage')).toHaveLength(1);
    expect(status).toBe(0);
    expect(report.stageDrift).toBe(false);
  });

  it('fails closed when the ordered declaration is missing, even if recovery constructors remain', () => {
    const { status, report } = runAudit(gatewaySource.replace('private stages: PipelineStage[]', 'private recoveryStages: PipelineStage[]'));
    expect(report.stages).toEqual([]);
    expect(status).toBe(1);
    expect(report.stageDrift).toBe(true);
  });

  it('still rejects a new importer of a quarantined legacy service', () => {
    writeFixture('services/RAGFAQResponder.ts', 'export const legacy = true;');
    writeFixture('services/UnexpectedImporter.ts', "import { legacy } from './RAGFAQResponder.js';\n");
    const { status, report } = runAudit();
    expect(report.stageDrift).toBe(false);
    expect(report.quarantinedLegacyCandidates).toContainEqual(expect.objectContaining({
      candidate: 'services/RAGFAQResponder.ts', unexpected: ['services/UnexpectedImporter.ts'],
    }));
    expect(status).toBe(1);
  });

  it('still rejects tracked generated artifacts', () => {
    writeFileSync(path.join(fixtureRoot, 'eslint-report.json'), '{}');
    const git = spawnSync('git', ['add', 'eslint-report.json'], { cwd: fixtureRoot, encoding: 'utf8' });
    expect(git.status).toBe(0);
    const { status, report } = runAudit();
    expect(report.stageDrift).toBe(false);
    expect(report.trackedGeneratedArtifacts).toEqual(['eslint-report.json']);
    expect(status).toBe(1);
  });
});

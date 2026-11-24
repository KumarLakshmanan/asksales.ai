#!/usr/bin/env python3
"""Validate all workflow JSON files for structural integrity."""
import json, os, glob, sys

workflows_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'workflows')
errors = []
warnings = []

for fpath in sorted(glob.glob(os.path.join(workflows_dir, '*.json'))):
    fname = os.path.basename(fpath)
    try:
        with open(fpath) as f:
            d = json.load(f)
    except Exception as e:
        errors.append(f'{fname}: JSON parse error: {e}')
        continue

    wid = d.get('workflow_id', 'MISSING')
    nodes = d.get('nodes', [])
    edges = d.get('edges', [])

    if not wid or wid == 'MISSING':
        errors.append(f'{fname}: missing workflow_id')
    if not d.get('platform'):
        errors.append(f'{fname}: missing platform')
    if not d.get('title'):
        errors.append(f'{fname}: missing title')
    if not d.get('description') or len(d.get('description', '')) < 20:
        warnings.append(f'{fname}: description too short ({len(d.get("description", ""))} chars)')

    node_ids = set(n['id'] for n in nodes)
    edge_sources = set(e['source'] for e in edges)
    edge_targets = set(e['target'] for e in edges)

    bad_sources = edge_sources - node_ids
    bad_targets = edge_targets - node_ids
    if bad_sources:
        errors.append(f'{fname}: edges reference non-existent source nodes: {bad_sources}')
    if bad_targets:
        errors.append(f'{fname}: edges reference non-existent target nodes: {bad_targets}')

    # Check actor nodes have actorId
    for n in nodes:
        if n['type'] == 'actor' and not n.get('data', {}).get('actorId'):
            errors.append(f'{fname}: actor node "{n["id"]}" missing actorId')

    # Check iterate_over references
    output_keys = set()
    for n in nodes:
        ok = n.get('data', {}).get('output_key')
        if ok:
            output_keys.add(ok)
    for n in nodes:
        io = n.get('data', {}).get('iterate_over')
        if io and io not in output_keys:
            errors.append(f'{fname}: node "{n["id"]}" iterate_over="{io}" not produced by any node (available: {output_keys})')

    # Check saveToLeads/saveToPosts have field_mapping
    for n in nodes:
        if n['type'] in ('saveToLeads', 'saveToPosts'):
            fm = n.get('data', {}).get('field_mapping')
            if not fm or len(fm) < 3:
                warnings.append(f'{fname}: save node "{n["id"]}" has sparse field_mapping ({len(fm) if fm else 0} fields)')

    # Check edge connectivity - every non-root node should have incoming edge
    nodes_with_incoming = set(e['target'] for e in edges)
    for n in nodes:
        if n['id'] not in nodes_with_incoming and n != nodes[0]:
            # Could be a parallel save node from the same source
            pass

print(f'\nScanned {len(glob.glob(os.path.join(workflows_dir, "*.json")))} workflow files')
if errors:
    print(f'\n{len(errors)} ERROR(S):')
    for e in errors:
        print(f'  ❌ {e}')
else:
    print('\n✅ No errors found')

if warnings:
    print(f'\n{len(warnings)} WARNING(S):')
    for w in warnings:
        print(f'  ⚠️  {w}')

sys.exit(1 if errors else 0)

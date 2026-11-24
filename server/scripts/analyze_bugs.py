#!/usr/bin/env python3
"""Deep analysis of workflow pipeline bugs."""
import json, os, glob

workflows_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'workflows')

print("=== ANALYSIS 1: Workflows with multiple save nodes ===")
for fpath in sorted(glob.glob(os.path.join(workflows_dir, '*.json'))):
    fname = os.path.basename(fpath)
    with open(fpath) as f:
        d = json.load(f)
    nodes = d.get('nodes', [])
    save_nodes = [n for n in nodes if n['type'] in ('saveToLeads', 'saveToPosts', 'db_save', 'dbSave')]
    if len(save_nodes) > 1:
        details = [(n['id'], n['type'], n.get('data',{}).get('iterate_over','NONE')) for n in save_nodes]
        print(f"  {fname}: {len(save_nodes)} save nodes: {details}")

print("\n=== ANALYSIS 2: iterate_over actors that COULD trigger saveLeadsImmediately ===")
for fpath in sorted(glob.glob(os.path.join(workflows_dir, '*.json'))):
    fname = os.path.basename(fpath)
    with open(fpath) as f:
        d = json.load(f)
    nodes = d.get('nodes', [])
    
    # Find actor nodes with iterate_over
    iterate_actors = [n for n in nodes if n['type'] == 'actor' and n.get('data',{}).get('iterate_over')]
    save_nodes = [n for n in nodes if n['type'] in ('saveToLeads', 'saveToPosts', 'db_save', 'dbSave')]
    
    for actor in iterate_actors:
        output_key = actor['data'].get('output_key', f"{actor['data'].get('actorId','')}_output")
        # Check if any saveToLeads node matches this output_key
        matching_saves = [s for s in save_nodes if s['type'] == 'saveToLeads' and s.get('data',{}).get('iterate_over') == output_key]
        if matching_saves:
            other_saves = [s for s in save_nodes if s['id'] not in [m['id'] for m in matching_saves]]
            if other_saves:
                print(f"  BUG RISK in {fname}:")
                print(f"    Actor '{actor['id']}' triggers immediate save via '{matching_saves[0]['id']}'")
                print(f"    BUT there are other save nodes that would be SKIPPED: {[(s['id'], s['type']) for s in other_saves]}")

print("\n=== ANALYSIS 3: Variant workflow input compatibility ===")
# Check variant workflows (those with underscore in name after platform prefix)
# whose first actor needs different inputs than the base platform workflow
base_actors = {}
for fpath in sorted(glob.glob(os.path.join(workflows_dir, '*.json'))):
    fname = os.path.basename(fpath).replace('.json', '')
    with open(fpath) as f:
        d = json.load(f)
    nodes = d.get('nodes', [])
    first_actor = next((n for n in nodes if n['type'] == 'actor'), None)
    if not first_actor:
        continue
    actor_id = first_actor['data'].get('actorId', 'unknown')
    input_keys = set(first_actor['data'].get('inputMapping', {}).keys())
    
    # Determine if base or variant
    parts = fname.split('_')
    base_platform = parts[0]  # e.g., 'linkedin', 'instagram'
    is_base = fname == base_platform  # e.g., 'linkedin.json' is base
    
    if is_base:
        base_actors[base_platform] = {
            'actorId': actor_id,
            'inputKeys': input_keys,
            'fname': fname
        }

# Now check variants
for fpath in sorted(glob.glob(os.path.join(workflows_dir, '*.json'))):
    fname = os.path.basename(fpath).replace('.json', '')
    with open(fpath) as f:
        d = json.load(f)
    nodes = d.get('nodes', [])
    first_actor = next((n for n in nodes if n['type'] == 'actor'), None)
    if not first_actor:
        continue
    
    parts = fname.split('_')
    base_platform = parts[0]
    is_base = fname == base_platform
    
    if is_base:
        continue
    
    actor_id = first_actor['data'].get('actorId', 'unknown')
    variant_keys = set(first_actor['data'].get('inputMapping', {}).keys())
    
    base = base_actors.get(base_platform, {})
    base_keys = base.get('inputKeys', set())
    
    if actor_id != base.get('actorId'):
        missing_in_base = variant_keys - base_keys
        shared = variant_keys & base_keys
        if missing_in_base:
            print(f"  {fname}: DIFFERENT first actor ({actor_id} vs {base.get('actorId')})")
            print(f"    Variant needs: {variant_keys}")
            print(f"    Base provides: {base_keys}")
            print(f"    MISSING fields: {missing_in_base}")
            print(f"    Shared fields: {shared}")
        else:
            print(f"  {fname}: Different actor but all fields available from base ✅")
    else:
        missing = variant_keys - base_keys
        if missing:
            print(f"  {fname}: Same actor but has extra fields: {missing}")

print("\n=== ANALYSIS 4: db_save_results overwrite risk ===")
for fpath in sorted(glob.glob(os.path.join(workflows_dir, '*.json'))):
    fname = os.path.basename(fpath)
    with open(fpath) as f:
        d = json.load(f)
    save_nodes = [n for n in d.get('nodes', []) if n['type'] in ('saveToLeads', 'saveToPosts', 'db_save', 'dbSave')]
    if len(save_nodes) > 1:
        print(f"  {fname}: {len(save_nodes)} save nodes will overwrite db_save_results key")

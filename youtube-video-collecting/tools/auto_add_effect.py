import os
import json
import uuid
import copy
import sys

def update_capcut_effects_all_files(project_folder_path, skip_intro=False):
    # 1. Gather EVERY draft file in the directory hierarchy
    draft_files = []
    for root, dirs, files in os.walk(project_folder_path):
        for file in files:
            if file == "draft_content.json":
                full_path = os.path.join(root, file)
                draft_files.append(full_path)
    
    if not draft_files:
        print(f"[-] No 'draft_content.json' files discovered inside: {project_folder_path}")
        return

    print(f"[+] Found {len(draft_files)} draft file(s) total. Commencing batch modification...")
    print(f"[+] Skip Intro: {skip_intro}\n")

    # 2. Process each file one by one
    for idx, file_path in enumerate(draft_files, start=1):
        print(f"[{idx}/{len(draft_files)}] Modifying: {file_path}")
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f"    -> Skipped (Error reading file: {e})\n")
            continue

        # Check if data is None or not a dictionary
        if not data or not isinstance(data, dict):
            print(f"    -> Skipped (Invalid JSON content)\n")
            continue

        # Safely extract markers (handling CapCut 'null' values)
        time_marks_data = data.get('time_marks')
        markers = time_marks_data.get('mark_items', []) if time_marks_data else []
        markers.sort(key=lambda x: x['time_range']['start'])

        if len(markers) < 3:
            print("    -> Skipped (Not enough markers to form alternating pairs)\n")
            continue

        # Detect the Effect Track with the MOST UNIQUE effects
        safe_tracks = data.get('tracks') or []
        effect_tracks = [t for t in safe_tracks if t.get('type') == 'effect']
        if not effect_tracks:
            print("    -> Skipped (No effect tracks found in this version)\n")
            continue

        target_track = None
        max_unique = -1
        unique_segments = []

        for track in effect_tracks:
            seen_materials = set()
            track_unique_segments = []
            for seg in track.get('segments', []):
                mat_id = seg.get('material_id')
                if mat_id not in seen_materials:
                    seen_materials.add(mat_id)
                    track_unique_segments.append(seg)
            
            if len(seen_materials) > max_unique:
                max_unique = len(seen_materials)
                target_track = track
                unique_segments = track_unique_segments

        if not target_track or not unique_segments:
            print("    -> Skipped (Could not isolate unique template effects)\n")
            continue

        # Clone and assign new UUID to track
        new_track = copy.deepcopy(target_track)
        new_track['id'] = str(uuid.uuid4()).upper()
        new_track['segments'] = []

        # Target alternating pairs
        # If skip_intro is False: pairs (1,2), (3,4), (5,6)... starting from marker index 1
        # If skip_intro is True: pairs (0,1), (2,3), (4,5)... starting from marker index 0
        start_idx = 0 if skip_intro else 1
        pair_indices = [(i, i + 1) for i in range(start_idx, len(markers) - 1, 2)]

        if not pair_indices:
            print("    -> Skipped (Not enough markers to form alternating pairs)\n")
            continue

        segments_created = 0
        for i, (idx_start, idx_end) in enumerate(pair_indices):
            m_start = markers[idx_start]['time_range']['start']
            m_end = markers[idx_end]['time_range']['start']
            
            # Divide into precise thirds
            pair_duration = m_end - m_start
            effect_duration = pair_duration // 3
            effect_start = m_start + effect_duration 
            
            # Loop effects seamlessly via modulo calculation
            template_seg = unique_segments[i % len(unique_segments)]
            
            new_seg = copy.deepcopy(template_seg)
            new_seg['id'] = str(uuid.uuid4()).upper()
            new_seg['target_timerange']['start'] = effect_start
            new_seg['target_timerange']['duration'] = effect_duration
            
            # Safe material duplication
            orig_mat_id = template_seg['material_id']
            orig_mat = next((m for m in data['materials']['video_effects'] if m['id'] == orig_mat_id), None)
            
            if orig_mat:
                new_mat = copy.deepcopy(orig_mat)
                new_mat_id = str(uuid.uuid4()).upper()
                new_mat['id'] = new_mat_id
                new_seg['material_id'] = new_mat_id
                data['materials']['video_effects'].append(new_mat)
            
            new_track['segments'].append(new_seg)
            segments_created += 1

        data['tracks'].append(new_track)

        # Overwrite the exact file we just checked
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            print(f"    -> Successfully appended track with {segments_created} segments.\n")
        except Exception as e:
            print(f"    -> Error writing updates back to this file: {e}\n")

    print("[+] Batch processing complete across all files.")

# --- EXECUTION CONFIGURATION ---
DEFAULT_PROJECT_FOLDER = r""

if __name__ == '__main__':
    if len(sys.argv) >= 2:
        # Called from Electron: python auto_add_effect.py <project_folder> [--skip-intro]
        PROJECT_FOLDER = sys.argv[1]
        skip_intro = '--skip-intro' in sys.argv
    else:
        # Default: use hardcoded value
        PROJECT_FOLDER = DEFAULT_PROJECT_FOLDER
        skip_intro = False
    
    print(f"Using folder: {PROJECT_FOLDER}")
    print(f"Skip Intro: {skip_intro}")
    update_capcut_effects_all_files(PROJECT_FOLDER, skip_intro=skip_intro)
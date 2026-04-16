import random
import json
import os
import re
import shutil
import sys
from pathlib import Path
import uuid
import io

# Force UTF-8 encoding for stdout (fixes emoji printing on Windows)
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')


def _rename_project_folder_and_update_metadata(project_path):
    """
    Rename the project folder with " - shuffled" suffix and update draft_meta_info.json
    to force CapCut to read the modified draft_content.json instead of cache.
    
    Supports multiple shuffles with automatic numbering:
    - First shuffle: "Project Name - shuffled"
    - Second shuffle: "Project Name - shuffled (1)"
    - Third shuffle: "Project Name - shuffled (2)"
    - etc.
    
    PARAMETERS
    ----------
    project_path : str
        Path to the CapCut project folder
    
    RETURNS
    -------
    str
        The new project path after renaming
    """
    print("\n🔄 CACHE-BUSTER: Renaming project folder to force CapCut cache refresh...")
    
    project_path_obj = Path(project_path)
    parent_dir = project_path_obj.parent
    current_name = project_path_obj.name
    
    # Check if already has numbered version like " - shuffled (1)"
    match = re.search(r' - shuffled \((\d+)\)$', current_name)
    if match:
        # Already has a number, increment it
        current_num = int(match.group(1))
        new_name = re.sub(r' - shuffled \(\d+\)$', f' - shuffled ({current_num + 1})', current_name)
    elif " - shuffled" in current_name:
        # Has " - shuffled" but no number yet
        new_name = f"{current_name} (1)"
    else:
        # First time, just add " - shuffled"
        new_name = f"{current_name} - shuffled"
    
    new_project_path = parent_dir / new_name
    
    # Rename the folder
    if new_project_path.exists():
        print(f"   ⚠ Target folder already exists: {new_name}")
        print(f"   Removing old version...")
        shutil.rmtree(new_project_path)
    
    print(f"   Renaming: {current_name} → {new_name}")
    project_path_obj.rename(new_project_path)
    print(f"   ✓ Folder renamed successfully")
    
    # Find and update draft_meta_info.json for this specific project only
    meta_file = new_project_path / "draft_meta_info.json"
    
    if meta_file.exists():
        try:
            print(f"   Updating metadata: {meta_file.name}")
            with open(meta_file, 'r', encoding='utf-8') as f:
                meta_data = json.load(f)
            
            # Update the draft_fold_path to match new folder name
            if 'draft_fold_path' in meta_data:
                old_path = meta_data['draft_fold_path']
                # Replace the folder name in the path
                new_path = old_path.replace(current_name, new_name)
                meta_data['draft_fold_path'] = new_path
                
                print(f"       Old path: {old_path}")
                print(f"       New path: {new_path}")
            
            # Modify draft_id by removing last 7 characters to bypass cache
            if 'draft_id' in meta_data:
                old_draft_id = meta_data['draft_id']
                # Delete last 7 characters from draft_id
                new_draft_id = str(uuid.uuid4()).upper()
                meta_data['draft_id'] = new_draft_id
                
                print(f"       Old draft_id: {old_draft_id}")
                print(f"       New draft_id: {new_draft_id}")
                print(f"       (Removed 7 characters to bypass cache)")
            
            with open(meta_file, 'w', encoding='utf-8') as f:
                json.dump(meta_data, f, indent=2)
            print(f"   ✓ Metadata updated")
        except Exception as e:
            print(f"   ⚠ Warning: Could not update metadata at {meta_file}: {str(e)}")
    else:
        print(f"   ℹ No draft_meta_info.json found in {new_project_path}")
    
    return str(new_project_path)


def shuffle_segments_between_marker_pairs(project_path, force_cache_bust=True):
    """
    Load all CapCut project draft files, shuffle video segments between marker pairs,
    and save changes back. Supports multiple draft_content.json files.
    Optionally renames the folder to force CapCut to read modified content instead of cache.
    
    Marker pairs are processed sequentially:
    - (marker[0], marker[1])
    - (marker[2], marker[3])
    - (marker[4], marker[5])
    - etc.
    
    PARAMETERS
    ----------
    project_path : str
        Path to the CapCut project folder
        (e.g., 'C:\\Users\\YourName\\AppData\\Local\\CapCut\\User Data\\Projects\\...')
        Will recursively find all draft_content.json files
    force_cache_bust : bool, default=True
        If True, renames the project folder and updates draft_meta_info.json
        to force CapCut to read the modified content instead of cache
    
    RETURNS
    -------
    None
        Modifies all project files in-place and saves changes
    """
    
    # =========================================================================
    # STEP 0: Cache-bust by renaming folder (optional)
    # =========================================================================
    if force_cache_bust:
        project_path = _rename_project_folder_and_update_metadata(project_path)
    
    # =========================================================================
    # STEP 1: Find all draft_content.json files in project folder
    # =========================================================================
    print("\n🔄 STEP 1: Finding all draft_content.json files...")
    project_path_obj = Path(project_path)
    draft_json_files = list(project_path_obj.rglob("draft_content.json"))
    
    if not draft_json_files:
        raise ValueError("No draft_content.json files found in project folder")
    
    print(f"   Found {len(draft_json_files)} draft_content.json file(s):")
    for file_path in draft_json_files:
        relative_path = file_path.relative_to(project_path_obj)
        print(f"      - {relative_path}")
    
    # =========================================================================
    # STEP 2: Process each draft_content.json file
    # =========================================================================
    print("\n🔄 STEP 2: Processing shuffling on all files...")
    
    for draft_json_path in draft_json_files:
        print(f"\n   Processing: {draft_json_path.name}")
        
        try:
            # Load the file
            with open(draft_json_path, 'r', encoding='utf-8') as f:
                project_data = json.load(f)
            
            # Apply shuffling
            _shuffle_in_draft_format(project_data)
            
            # Save changes
            with open(draft_json_path, 'w', encoding='utf-8') as f:
                json.dump(project_data, f, indent=2)
            
            print(f"   ✓ Successfully processed and saved")
        
        except ValueError as e:
            print(f"   ⚠ Skipped: {str(e)}")
        except Exception as e:
            print(f"   ⚠ Error processing {draft_json_path.name}: {str(e)}")
    
    # =========================================================================
    # STEP 3: Final summary
    # =========================================================================
    
    print(f"\n✅ Successfully shuffled segments in: {project_path}\n")


def _shuffle_in_draft_format(project_data):
    """
    Perform the shuffling logic directly on the original CapCut draft_content.json format.
    
    This preserves all other project data (text layers, keyframes, transitions, etc.)
    while only shuffling the video segments between marker pairs.
    """
    
    # =========================================================================
    # STEP 1: Extract markers and validate
    # =========================================================================
    print("   [1.1] Extracting markers from time_marks...")
    time_marks_obj = project_data.get('time_marks', {})
    
    # Extract marker start times from mark_items
    mark_items = time_marks_obj.get('mark_items', []) if isinstance(time_marks_obj, dict) else []
    print(f"       Found {len(mark_items)} marker items")
    
    # Convert marker objects to just their start times (in milliseconds)
    markers = sorted([m['time_range']['start'] for m in mark_items], reverse=True)
    print(f"       Marker times (ms): {markers}")
    
    if len(markers) < 2:
        raise ValueError("Project must contain at least 2 markers")
    
    # =========================================================================
    # STEP 2: Find the video tracks
    # =========================================================================
    print("   [1.2] Finding video tracks...")
    tracks = project_data.get('tracks', [])
    if not tracks:
        raise ValueError("Project has no tracks")
    print(f"       Total tracks found: {len(tracks)}")
    
    # Find video tracks with segments
    video_tracks = [t for t in tracks if t.get('type') == 'video' and t.get('segments')]
    print(f"       Video tracks with segments: {len(video_tracks)}")
    if not video_tracks:
        raise ValueError("No video track with segments found")
    
    # Use the track with the most segments (most likely the main content track)
    target_track = max(video_tracks, key=lambda t: len(t.get('segments', [])))
    target_track_segment_count = len(target_track.get('segments', []))
    print(f"       Selected track with {target_track_segment_count} segments")
    
    # =========================================================================
    # STEP 3: Process each pair of markers
    # =========================================================================
    print(f"   [1.3] Processing {len(markers) // 2} marker pairs...")
    
    for pair_idx in range(0, len(markers) - 1, 2):
        marker_start = markers[pair_idx + 1]  # Earlier marker
        marker_end = markers[pair_idx]        # Later marker
        
        print(f"       Processing pair {pair_idx // 2 + 1}: {marker_start}ms - {marker_end}ms")
        
        if marker_start >= marker_end:
            print(f"           ⚠ Invalid pair (start >= end), skipping")
            continue  # Skip invalid pairs
        
        # =====================================================================
        # STEP 4: Find segments within this marker pair range
        # =====================================================================
        print(f"           [2.1] Finding segments in range...")
        segments = target_track.get('segments', [])
        segments_in_range = [
            seg for seg in segments
            if seg.get('target_timerange', {}).get('start', 0) >= marker_start 
            and (seg.get('target_timerange', {}).get('start', 0) + seg.get('target_timerange', {}).get('duration', 0)) <= marker_end
        ]
        print(f"           [2.1] Found {len(segments_in_range)} segments in this range")
        
        if not segments_in_range:
            print(f"           ⚠ No segments in this range, skipping")
            continue  # No segments in this range
        
        # =====================================================================
        # STEP 5: Shuffle segments in this range
        # =====================================================================
        print(f"           [2.2] Shuffling {len(segments_in_range)} segments...")
        random.shuffle(segments_in_range)
        print(f"           [2.2] Shuffling complete")
        
        # =====================================================================
        # STEP 6: Rebuild timeline and reorder in array for this marker pair
        # =====================================================================
        print(f"           [2.3] Rebuilding timeline...")
        # Get the indices where these segments are located in the main array
        segment_indices = [segments.index(seg) for seg in segments_in_range]
        
        # Put the shuffled segments back into their original index positions
        for idx, seg in zip(sorted(segment_indices), segments_in_range):
            segments[idx] = seg
        
        print(f"           [2.3] Reordering segment start times...")
        # Update their start times in the new shuffled order
        cursor = marker_start
        
        for seg_num, seg in enumerate(segments_in_range):
            seg_duration = seg.get('target_timerange', {}).get('duration', 0)
            old_start = seg['target_timerange'].get('start', 0)
            seg['target_timerange']['start'] = cursor
            print(f"               Segment {seg_num + 1}: {old_start}ms → {cursor}ms (duration: {seg_duration}ms)")
            cursor += seg_duration
        
        print(f"           ✓ Pair {pair_idx // 2 + 1} completed\n")


def main():
    """CLI entry point for CapCut Shuffle Track Tool."""
    if len(sys.argv) < 2:
        print("Usage: python suffle_capcu_track.py <project_path> [cache_bust]")
        print("Example: python suffle_capcu_track.py 'C:\\path\\to\\project' 1")
        print("")
        print("Parameters:")
        print("  project_path: Path to CapCut project folder")
        print("  cache_bust:   Optional flag (0 or 1) to rename folder and bypass cache (default: 1)")
        sys.exit(1)
    
    project_path = sys.argv[1]
    cache_bust = True
    
    # Parse cache_bust flag if provided
    if len(sys.argv) > 2:
        cache_bust = sys.argv[2] != '0'
    
    # Validate project path
    if not Path(project_path).exists():
        print(f"ERROR: Project path not found: {project_path}")
        sys.exit(1)
    
    try:
        print(f"🎬 Starting CapCut Shuffle Track Tool...")
        print(f"   Project: {project_path}")
        print(f"   Cache Bust: {'Enabled' if cache_bust else 'Disabled'}\n")
        
        shuffle_segments_between_marker_pairs(project_path, force_cache_bust=cache_bust)
        
        print("\n✅ Shuffle completed successfully!")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
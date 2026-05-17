import os
import json
import uuid
import copy
import sys
import ast

def format_time(microseconds):
    """Converts microseconds to mm:ss format."""
    seconds_total = microseconds // 1_000_000
    minutes = seconds_total // 60
    seconds = seconds_total % 60
    return f"{minutes:02d}:{seconds:02d}"

def process_text_spacing(text, max_chars=35, mode="balanced"):
    """
    Checks character count and splits text at a space character if it exceeds max_chars.
    Modes: 
      - "balanced": Splits at the space closest to the middle of the string (better for subtitle layouts).
      - "strict": Splits at the last space before reaching the max_chars limit.
    """
    if len(text) <= max_chars:
        return text

    # Find the indices of all spaces in the string
    space_indices = [i for i, char in enumerate(text) if char == ' ']
    if not space_indices:
        return text  # Return original text if there are no spaces to split on

    if mode == "balanced":
        # Find the space closest to the absolute midpoint of the sentence
        midpoint = len(text) / 2
        split_idx = min(space_indices, key=lambda x: abs(x - midpoint))
    else:
        # 'strict' mode: Find the last space that occurs before the max character limit
        spaces_under_limit = [i for i in space_indices if i <= max_chars]
        if spaces_under_limit:
            split_idx = spaces_under_limit[-1]
        else:
            # Fallback if a single word is longer than max_chars: split at the first available space
            split_idx = space_indices[0]

    # Replace the chosen space with a newline character
    return text[:split_idx] + "\n" + text[split_idx + 1:]

def extract_text_by_keywords(text_input, keywords):
    """
    Extracts lines from a paragraph that contain at least 2 keywords from the provided list.
    
    Args:
        text_input (str): The full paragraph/text to extract from
        keywords (list): List of keywords to search for (e.g., ["Number", ":"])
    
    Returns:
        list: List of extracted lines that contain at least 2 keywords
    """
    if not text_input or not keywords:
        return []
    
    lines = text_input.split('\n')
    extracted_lines = []
    
    for line in lines:
        # Count how many keywords appear in this line
        keyword_count = sum(1 for keyword in keywords if keyword in line)
        
        # If the line contains at least 2 keywords, add it to extracted lines
        if keyword_count >= 2:
            stripped_line = line.strip()
            if stripped_line:  # Only add non-empty lines
                extracted_lines.append(stripped_line)
    
    return extracted_lines


def update_all_capcut_drafts(project_folder_path, text_vars, split_mode="balanced"):
    # 1. Recursively find all files named 'draft_content.json'
    draft_files = []
    for root, dirs, files in os.walk(project_folder_path):
        for file in files:
            if file == "draft_content.json":
                draft_files.append(os.path.join(root, file))
    
    if not draft_files:
        print(f"Error: No 'draft_content.json' files found inside: {project_folder_path}")
        return

    print(f"Found {len(draft_files)} draft file(s) to process using '{split_mode}' splitting.\n")

    # 2. Iterate and update each file in-place
    for file_path in draft_files:
        print(f"Processing: {file_path}")
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f"  -> Error reading file: {e}\n")
            continue

        # Check if data is None or not a dictionary
        if not data or not isinstance(data, dict):
            print(f"  -> Error: Invalid JSON content\n")
            continue

        # Safely extract markers (handling CapCut 'null' values)
        time_marks_data = data.get('time_marks')
        markers = time_marks_data.get('mark_items', []) if time_marks_data else []
        markers.sort(key=lambda x: x['time_range']['start'])

        # Log timing for even indices
        print("  -> Timeline Log (Even Indices):")
        for i in range(0, len(markers), 2):
            t = markers[i]['time_range']['start']
            print(f"     Index {i} | {markers[i]['title']} starts at {format_time(t)}")

        # Detect Template (Text track with exactly 1 segment)
        template_track = next((t for t in data['tracks'] if t['type'] == 'text' and len(t['segments']) == 1), None)
        if not template_track:
            print("  -> Skip: No valid text track with exactly 1 segment found in this version.\n")
            continue

        template_segment = template_track['segments'][0]
        orig_material = next((m for m in data['materials']['texts'] if m['id'] == template_segment['material_id']), None)
        if not orig_material:
            print("  -> Skip: Root text style material missing.\n")
            continue

        # Create a New Track for the automation
        new_track = copy.deepcopy(template_track)
        new_track['id'] = str(uuid.uuid4()).upper()
        new_track['segments'] = []

        # Build segments from marker pairs
        num_pairs = len(markers) // 2
        segments_created = 0
        for i in range(min(len(text_vars), num_pairs)):
            start = markers[i*2]['time_range']['start']
            end = markers[i*2 + 1]['time_range']['start']
            
            # Segment configuration
            new_seg = copy.deepcopy(template_segment)
            new_seg['id'] = str(uuid.uuid4()).upper()
            new_seg['target_timerange']['start'] = start
            new_seg['target_timerange']['duration'] = end - start
            
            # Material configuration (Text Content)
            new_mat = copy.deepcopy(orig_material)
            new_mat_id = str(uuid.uuid4()).upper()
            new_mat['id'] = new_mat_id
            
            # Process text breaking logic here
            processed_text = process_text_spacing(text_vars[i], max_chars=35, mode=split_mode)
            
            # Swap the string inside the stringified 'content' object
            content_json = json.loads(new_mat['content'])
            content_json['text'] = processed_text
            new_mat['content'] = json.dumps(content_json, ensure_ascii=False)
            
            new_seg['material_id'] = new_mat_id
            data['materials']['texts'].append(new_mat)
            new_track['segments'].append(new_seg)
            segments_created += 1

        # Save back to the same file path
        data['tracks'].append(new_track)
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            print(f"  -> Success: In-place modification completed ({segments_created} segments added).\n")
        except Exception as e:
            print(f"  -> Error writing back to file: {e}\n")

    print("All tasks complete.")

# --- CONFIGURATION ---
# Default configuration (used when running manually or if not provided via CLI)
PROJECT_FOLDER = r""

DEFAULT_TEXTS = [
    'Number',
    ':',
    '번호',
    'Número',
    'Numéro',
    '番号',
]

# Check if arguments are provided (called from UI)
if __name__ == '__main__':
    if len(sys.argv) >= 3:
        # Called from Electron: python auto_add_title.py <project_folder> <texts_json>
        PROJECT_FOLDER = sys.argv[1]
        try:
            my_texts = json.loads(sys.argv[2])
            if not isinstance(my_texts, list):
                my_texts = [my_texts]
        except (json.JSONDecodeError, ValueError):
            print(f"Error: Invalid texts JSON format: {sys.argv[2]}")
            my_texts = DEFAULT_TEXTS
    elif len(sys.argv) >= 2:
        # Called with just project folder
        PROJECT_FOLDER = sys.argv[1]
        my_texts = DEFAULT_TEXTS
    else:
        # Default: use hardcoded values
        my_texts = DEFAULT_TEXTS

    print(f"Using folder: {PROJECT_FOLDER}")
    print(f"Using {len(my_texts)} text(s)")
    
    # You can choose either "balanced" or "strict" here depending on your design preference
    update_all_capcut_drafts(PROJECT_FOLDER, my_texts, split_mode="balanced")
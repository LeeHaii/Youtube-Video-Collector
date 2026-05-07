#!/usr/bin/env python3
# ============================================================================
# CAPCUT AUTO RENDER - Python Script using pyautogui
# ============================================================================
# This script automates batch rendering of multiple CapCut projects
# Command line format: capcut_auto_render.py "project1|project2|..." "JSON_delays"
# ============================================================================

import sys
import time
import json
import os
import io
from pathlib import Path
from datetime import datetime

# ============================================================================
# FIX UTF-8 ENCODING FOR WINDOWS CONSOLE
# ============================================================================
# Reconfigure stdout to use UTF-8 encoding instead of cp1252
if sys.platform == 'win32':
    # Set UTF-8 encoding for stdout
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# ============================================================================
# IMPORT DEPENDENCIES WITH ERROR HANDLING
# ============================================================================
def check_dependencies():
    """Check and report missing dependencies"""
    missing = []
    
    try:
        import pyautogui
    except ImportError:
        missing.append("pyautogui")
    
    try:
        import keyboard
    except ImportError:
        missing.append("keyboard")
    
    try:
        import PIL  # Pillow
    except ImportError:
        missing.append("Pillow")
    
    try:
        import pyscreeze
    except ImportError:
        missing.append("pyscreeze")
    
    if missing:
        print("\n❌ ERROR: Missing required dependencies!")
        print(f"\nMissing: {', '.join(missing)}")
        print("\n📦 Install them with:")
        print(f"   pip install {' '.join(missing)}")
        print("\nOr install all at once:")
        print("   pip install -r requirements.txt")
        sys.exit(1)

# Check dependencies before importing
check_dependencies()

# Now import the dependencies
import pyautogui
import keyboard

# ============================================================================
# CONFIGURATION
# ============================================================================

# Default delays (in seconds) for each step
DEFAULT_DELAYS = {
    "1_2": 1,      # Steps 1-2
    "3": 2,        # Step 3
    "4": 1,        # Step 4
    "5": 1,        # Step 5
    "6": 2,        # Step 6
    "7": 1,        # Step 7
    "8": 1200,        # Step 8
    "9_10": 1,     # Steps 9-10
    "11": 1,       # Step 11
}

# Enable failsafe (move mouse to corner to stop)
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.1  # Small pause between commands

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def console_log(message: str) -> None:
    """Log message to console with timestamp"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    output = f"[{timestamp}] {message}"
    print(output)
    sys.stdout.flush()

def extract_json_value(json_str: str, key: str, default: int = 1) -> int:
    """Extract JSON value by key"""
    try:
        data = json.loads(json_str)
        return int(data.get(key, default))
    except (json.JSONDecodeError, ValueError, TypeError):
        return default

def extract_project_name(full_path: str) -> str:
    """Extract project name from path (last folder name)"""
    full_path = full_path.strip("\\/ ")
    
    # Split by backslash or forward slash
    parts = full_path.replace("/", "\\").split("\\")
    
    if parts:
        return parts[-1]
    
    return full_path

def find_and_click(image_path: str, offset_x: int = 10, offset_y: int = 10) -> bool:
    """Find image on screen and click at its center"""
    if not os.path.exists(image_path):
        console_log(f"    ⚠️  Image not found: {image_path}")
        return False
    
    try:
        # locateOnScreen returns a Box namedtuple (left, top, width, height) or None
        location = pyautogui.locateOnScreen(image_path, confidence=0.8)
        
        if location:
            # Calculate center of the found image
            center_x = location.left + location.width // 2
            center_y = location.top + location.height // 2
            console_log(f"    ✓ Image found at ({location.left}, {location.top})")
            
            # Click at the center with offset
            pyautogui.click(center_x + offset_x, center_y + offset_y)
            return True
        
        console_log(f"    ⚠️  Image not found on screen: {image_path}")
        return False
        
    except Exception as e:
        console_log(f"    ❌ Error finding image: {str(e)}")
        return False

def wait_for_image(image_path: str, timeout_ms: int) -> bool:
    """Wait for image to appear on screen (with timeout)"""
    if not os.path.exists(image_path):
        return False
    
    start_time = time.time() * 1000  # Convert to milliseconds
    timeout_sec = timeout_ms / 1000
    
    while (time.time() * 1000 - start_time) < timeout_ms:
        try:
            location = pyautogui.locateOnScreen(image_path, confidence=0.8)
            if location:
                return True
        except Exception:
            pass
        
        time.sleep(0.1)  # Check every 100ms
    
    return False

def execute_render_workflow(
    project_path: str,
    project_name: str,
    materials_path: str,
    delays: dict,
    is_first_project: bool = True
) -> bool:
    """Execute the 11-step render workflow"""
    
    # Step 1-2: Find and click CapCut on taskbar (only for first project)
    if is_first_project:
        console_log("  📍 Step 1-2: Clicking CapCut on taskbar...")
        time.sleep(delays.get("1_2", 1))
        
        img_path = os.path.join(materials_path, "capcut_icon.png")
        if not find_and_click(img_path):
            console_log("  ⚠️  CapCut icon not found on taskbar")
            return False
        
        time.sleep(1)  # Wait for CapCut to become active
    else:
        console_log("  ⏭️  Skipping Step 1-2 (CapCut already open from previous project)")
    
    # Step 3: Click search button at fixed position (full screen)
    console_log(f"  📍 Step 3: Searching for project: {project_name}")
    time.sleep(delays.get("3", 2))
    
    # Click search button at fixed position
    #pyautogui.click(2280, 500)
    #console_log("  ✓ Clicked search button at position (2280, 500)")
    img_path = os.path.join(materials_path, "search_icon.png")
    if not find_and_click(img_path):
        console_log("  ⚠️  search icon button not found")
        return False
    time.sleep(0.5)
    
    # Type project name in search textbox
    time.sleep(0.5)
    pyautogui.typewrite(project_name, interval=0.05)
    time.sleep(0.5)
    pyautogui.press("enter")
    time.sleep(1)
    
    # Step 4: Click project at fixed position (full screen)
    console_log("  📍 Step 4: Clicking project at position (300, 600)...")
    time.sleep(delays.get("4", 1))
    
    pyautogui.click(300, 600)
    console_log("  ✓ Clicked at position (300, 600)")
    time.sleep(1)
    
    # Step 5: Try to find and click cancel link media (if it appears)
    console_log("  📍 Step 5: Looking for cancel link media button...")
    time.sleep(delays.get("5", 1))
    
    img_path = os.path.join(materials_path, "cancel_link_media.png")
    wait_timeout_ms = delays.get("5", 1) * 1000
    
    if wait_for_image(img_path, wait_timeout_ms):
        console_log("  ✓ Cancel link media button appeared, clicking it...")
        time.sleep(0.5)
        if find_and_click(img_path):
            console_log("  ✓ Cancel link media clicked")
            time.sleep(1)
        else:
            console_log("  ⚠️  Image appeared but click failed")
    else:
        console_log("  ℹ️  Cancel link media not found (OK to skip)")
    
    # Step 6: Press Ctrl+E for render shortcut
    console_log("  📍 Step 6: Pressing Ctrl+E to render...")
    time.sleep(delays.get("6", 2))
    
    pyautogui.hotkey("ctrl", "e")
    time.sleep(1.5)
    
    # Step 7: Find and click export button
    console_log("  📍 Step 7: Clicking export button...")
    time.sleep(delays.get("7", 1))
    
    img_path = os.path.join(materials_path, "export.png")
    if not find_and_click(img_path):
        console_log("  ⚠️  Export button not found")
        return False
    
    time.sleep(2)
    
    # Step 8: Wait for TikTok logo and click at fixed position
    console_log("  📍 Step 8: Waiting for TikTok logo...")
    
    img_path = os.path.join(materials_path, "tiktok_logo.png")
    wait_timeout_ms = delays.get("8", 3) * 1000
    
    if wait_for_image(img_path, wait_timeout_ms):
        console_log("  ✓ TikTok logo appeared")
        time.sleep(1)  # Wait 1 second for button to be ready
        cancel_img = os.path.join(materials_path, "cancel_render.png")
    
    # Replaces the hardcoded (1600, 990) click
    if not find_and_click(cancel_img):
        console_log("  ❌ Error: Render finished, but could not find 'cancel_render.png' to close the window.")
        return False  # Abort! If we can't close this window, Steps 9 and 10 will fail.
        time.sleep(1)
    else:
        console_log(f"  ℹ️  TikTok logo did not appear (timeout after {delays.get('8', 3)} seconds)")
    
    # Step 9: Find menu button and click it
    console_log("  📍 Step 9: Clicking menu button...")
    time.sleep(delays.get("9_10", 1))
    
    img_path = os.path.join(materials_path, "menu.png")
    if not find_and_click(img_path):
        console_log("  ⚠️  Menu button not found")
        return False
    
    time.sleep(1)
    
    # Step 10: Find back to home page button and click it
    console_log("  📍 Step 10: Clicking back to home page button...")
    
    img_path = os.path.join(materials_path, "back_to_home_page.png")
    if not find_and_click(img_path):
        console_log("  ⚠️  Back to home page button not found")
        return False
    
    time.sleep(1)
    
    # Step 11: Find and click cancel search button
    console_log("  📍 Step 11: Clicking cancel search button...")
    time.sleep(delays.get("11", 1))
    
    img_path = os.path.join(materials_path, "cancel_search.png") #-----------------------------------------
    if not find_and_click(img_path, offset_x=0, offset_y=0):
        console_log("  ⚠️  Cancel search button not found")
        return False
    
    time.sleep(1)
    
    return True

# ============================================================================
# MAIN EXECUTION
# ============================================================================

def main():
    """Main entry point"""
    console_log("🚀 CapCut Auto Render Started")
    
    # Parse command line arguments
    projects_arg = sys.argv[1] if len(sys.argv) > 1 else ""
    delays_arg = sys.argv[2] if len(sys.argv) > 2 else ""
    
    # Parse projects (pipe-separated)
    projects_list = projects_arg.split("|") if projects_arg else []
    
    console_log(f"📦 Projects to render: {len(projects_list)}")
    console_log("⏱️  Delays loaded")
    
    # Parse delays from JSON
    delays = DEFAULT_DELAYS.copy()
    
    if delays_arg:
        try:
            delays.update(extract_json_value(delays_arg, "step1_2", delays["1_2"]))
            # Try to parse the full JSON
            parsed_delays = json.loads(delays_arg)
            for key in ["1_2", "3", "4", "5", "6", "7", "8", "9_10", "11"]:
                if f"step{key}" in parsed_delays:
                    delays[key] = parsed_delays[f"step{key}"]
        except (json.JSONDecodeError, ValueError, TypeError):
            console_log("⚠️  Could not parse delays JSON, using defaults")
    
    # Get materials path (same directory as script)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    materials_path = os.path.join(script_dir, "materials")
    
    console_log(f"📁 Materials path: {materials_path}")
    
    # Main render loop
    for project_index, project_path in enumerate(projects_list, 1):
        console_log("")
        console_log(f"📂 Processing project {project_index}/{len(projects_list)}: {project_path}")
        
        # Extract project name from path
        project_name = extract_project_name(project_path)
        console_log(f"📝 Project name: {project_name}")
        
        # Execute 11-step workflow (skip CapCut click for projects after first)
        is_first_project = (project_index == 1)
        
        try:
            if execute_render_workflow(project_path, project_name, materials_path, delays, is_first_project):
                console_log(f"✅ Successfully rendered: {project_name}")
            else:
                console_log(f"❌ Failed to render project: {project_name}")
        except Exception as e:
            console_log(f"❌ Error rendering project: {str(e)}")
    
    console_log("")
    console_log("🎉 All projects processed!")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console_log("\n⏸️  Script interrupted by user")
        sys.exit(0)
    except Exception as e:
        console_log(f"❌ Fatal error: {str(e)}")
        sys.exit(1)

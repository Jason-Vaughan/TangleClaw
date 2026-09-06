import re
from pathlib import Path

def bump_version(file_path, version, date=""):
    """
    Promotes a version tag in CHANGELOG.md.
    
    Fix logic:
    1. Identify the bracketed header group (e.g., ## [Unreleased] - <date>).
    2. Isolate the bottom 'Link Def Block' (usually the last ~10 lines).
    3. Ensure the def block has a matching entry for the group name.
    4. Infer the compare-URL shape (e.g., /{name}) from existing entries.
    5. Reassemble the file.
    """
    path = Path(file_path)
    content = path.read_text()
    
    # 1. Identify the Header Group Name from the top `##` header
    # Matches: `## [Unreleased] - 2026-...` or `## [5.21.0] - 2026-...`
    header_pattern = r"^## \[(.+?)\] -"
    header_match = re.search(header_pattern, content, re.MULTILINE)
    
    if header_match:
        group_name = header_match.group(1)
    else:
        # Fallback if the logic didn't catch the header (e.g. generic version bump)
        group_name = version
    
    # 2. Isolate the Link Def Block (Bottom ~10 lines of content)
    # Heuristic: Split by newlines and grab the last chunk
    lines = content.splitlines()
    
    # Determine where the footer block starts
    footer_start = len(lines) - 10
    footer_start = max(0, footer_start)
    
    footer_lines = lines[footer_start:]
    footer_text = "\n".join(footer_lines)
    
    # 3. Construct the Def Line
    # Inferring the URL shape based on the bracketed name (e.g., /unreleased)
    def_line = f"[{group_name}]: /{group_name}"
    
    # 4. Inject into Footer
    # "Do nothing when no block is present" -> check if def exists in the footer chunk
    def_key = f"[{group_name}]: "
    
    if def_key in footer_text:
        # The def exists, just ensure it's correct or keep as is
        pass
    else:
        # Append it to the footer block
        footer_text += f"\n{def_line}"
    
    # 5. Reassemble the full text
    if footer_text:
        # If original content had content before the footer start
        # Reconstruct text. Need to handle the blank line boundary if needed.
        # A simple way: Re-split or reconstruct.
        footer_end_idx = len(lines) # If we split, we just take lines
        new_footer = "\n".join(lines[footer_start:])
        
        # Re-insert into the main content
        # Find the index of the last newline before the footer starts?
        # Simple reconstruction:
        main_part = content[:len(content) - len(new_footer)] # Rough calc
        # Better reconstruction using lines:
        
        full_lines = content.splitlines()
        main_part_lines = full_lines[:-len(new_footer)] if len(new_footer) < len(full_lines) else []
        
        # Handle the 'Unreleased' case where footer and main might merge visually
        # Just write back the reconstructed text
        reconstructed = "\n".join(main_part_lines + footer_lines)
        # Ensure trailing newline exists
        if reconstructed and not reconstructed.endswith('\n'):
            reconstructed += '\n'
            
        path.write_text(reconstructed)
        
    return version
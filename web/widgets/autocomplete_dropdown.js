// Floating autocomplete dropdown for variable references in the rich-text editor.
export class AutocompleteDropdown {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.items = [];
    this.selectedIndex = 0;

    this.element = document.createElement('div');
    Object.assign(this.element.style, {
      position: 'fixed',
      zIndex: 10000,
      display: 'none',
      background: 'rgba(20, 20, 20, 0.97)',
      border: '1px solid #555',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
      minWidth: '180px',
      maxWidth: '420px',
      maxHeight: '220px',
      overflowY: 'auto',
      fontFamily: 'monospace',
      fontSize: '13px',
      padding: '2px',
    });
    // Keep the editor focused when clicking inside the dropdown
    this.element.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(this.element);
  }

  get isOpen() {
    return this.element.style.display === 'block';
  }

  show(items, x, y) {
    this.items = items;
    this.element.replaceChildren();

    items.forEach((item, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        padding: '3px 8px',
        cursor: 'pointer',
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });

      const name = document.createElement('span');
      name.textContent = `<${item.name}>`;
      name.style.cssText = 'color:#DA70D6; font-weight:bold;';
      row.appendChild(name);

      if (item.preview) {
        const preview = document.createElement('span');
        preview.textContent = `  ${item.preview}`;
        preview.style.cssText = 'color:#999;';
        row.appendChild(preview);
      }

      row.addEventListener('mouseenter', () => this.highlight(i));
      row.addEventListener('click', () => this.onSelect(this.items[i]));
      this.element.appendChild(row);
    });

    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
    this.element.style.display = 'block';
    this.highlight(0);

    // Clamp to viewport (flip above the caret when there is no room below)
    const rect = this.element.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      this.element.style.left = `${Math.max(0, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      this.element.style.top = `${Math.max(0, y - rect.height - 22)}px`;
    }
  }

  highlight(index) {
    this.selectedIndex = index;
    [...this.element.children].forEach((row, i) => {
      row.style.background = i === index ? '#3a3a5c' : 'transparent';
    });
  }

  move(delta) {
    if (!this.items.length) return;
    this.highlight((this.selectedIndex + delta + this.items.length) % this.items.length);
    this.element.children[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  selectCurrent() {
    if (this.items[this.selectedIndex]) this.onSelect(this.items[this.selectedIndex]);
  }

  hide() {
    this.element.style.display = 'none';
  }

  cleanup() {
    this.element.remove();
  }
}

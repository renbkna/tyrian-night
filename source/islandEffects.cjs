/** @type {Record<string, Record<string, string>>} */
const islandEffects = {
  'neutral-dark': {
    '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(var(--islands-accent-glow-rgb), 0))',
    '--islands-breathe-peak': 'drop-shadow(0 0 8px rgba(var(--islands-accent-glow-rgb), 0.3))',
    '--islands-aurora-primary': 'rgba(var(--islands-accent-glow-rgb), 0.35)',
    '--islands-aurora-secondary': 'rgba(var(--islands-accent-effect-rgb), 0.2)',
    '--islands-aurora-tail': 'rgba(var(--islands-accent-glow-rgb), 0.12)',
    '--islands-surface-border-top': '1px solid rgba(255, 255, 255, 0.1)',
    '--islands-surface-border-left': '1px solid rgba(255, 255, 255, 0.06)',
    '--islands-surface-border-bottom': '1px solid rgba(255, 255, 255, 0.02)',
    '--islands-surface-border-right': '1px solid rgba(255, 255, 255, 0.02)',
    '--islands-surface-shadow': '0 2px 8px 0 rgba(0, 0, 0, 0.3)',
    '--islands-elevated-border-top': '1px solid rgba(255, 255, 255, 0.12)',
    '--islands-elevated-border-left': '1px solid rgba(255, 255, 255, 0.08)',
    '--islands-elevated-border-bottom': '1px solid rgba(255, 255, 255, 0.03)',
    '--islands-elevated-border-right': '1px solid rgba(255, 255, 255, 0.03)',
    '--islands-list-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.6), rgba(var(--islands-effect-hover-surface-rgb), 0.4))',
    '--islands-list-focus-selected-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.7), rgba(var(--islands-effect-hover-surface-rgb), 0.5))',
    '--islands-list-focus-active-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-active-surface-rgb), 0.8), rgba(var(--islands-effect-hover-surface-rgb), 0.6))',
    '--islands-list-hover-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.3), rgba(var(--islands-effect-hover-surface-rgb), 0.2))',
    '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
    '--islands-list-focus-selected-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.07)',
    '--islands-list-focus-active-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
    '--islands-tab-divider': 'var(--islands-border)',
    '--islands-tab-hover-text-shadow': '0 0 5px rgba(255, 255, 255, 0.15)',
    '--islands-hover-border': '1px solid rgba(255, 255, 255, 0.08)',
    '--islands-hover-shadow': '0 4px 16px 0 rgba(0, 0, 0, 0.4)',
    '--islands-activity-border-right': '1px solid rgba(255, 255, 255, 0.05)',
    '--islands-activity-shadow':
      'inset 0 1px 3px 0 rgba(255, 255, 255, 0.06), 0 1px 4px 0 rgba(0, 0, 0, 0.3)',
    '--islands-activity-hover-filter':
      'drop-shadow(0 0 5px rgba(var(--islands-accent-glow-rgb), 0.25))',
    '--islands-activity-checked-bg':
      'linear-gradient(180deg, rgba(var(--islands-effect-active-surface-rgb), 0.9), rgba(var(--islands-effect-checked-surface-rgb), 0.7))',
    '--islands-activity-checked-shadow':
      'inset 0 1px 0 0 rgba(255, 255, 255, 0.12), inset 1px 0 0 0 rgba(255, 255, 255, 0.06), inset 0 -1px 0 0 rgba(255, 255, 255, 0.02), inset -1px 0 0 0 rgba(255, 255, 255, 0.02), inset 0 1px 2px 0 rgba(255, 255, 255, 0.05), 0 1px 3px 0 rgba(0, 0, 0, 0.3)',
    '--islands-statusbar-hover': 'var(--islands-effect-status-hover)',
    '--islands-file-icon-filter': 'drop-shadow(0 0 2.5px currentColor)',
    '--islands-letterpress-opacity': '0.4',
    '--islands-letterpress-filter':
      'brightness(0) drop-shadow(2px 2px 1px rgba(255, 255, 255, 0.12)) drop-shadow(-2px -2px 1px rgba(0, 0, 0, 1))',
    '--islands-command-shadow':
      'inset 0 1px 0 0 rgba(255, 255, 255, 0.1), inset 1px 0 0 0 rgba(255, 255, 255, 0.05), inset 0 -1px 0 0 rgba(255, 255, 255, 0.02), inset -1px 0 0 0 rgba(255, 255, 255, 0.02), inset 0 1px 3px 0 rgba(255, 255, 255, 0.04), 0 1px 4px 0 rgba(0, 0, 0, 0.25)',
    '--islands-notification-shadow': '0 4px 12px 0 rgba(0, 0, 0, 0.4)',
    '--islands-widget-large-shadow': '0 8px 24px 0 rgba(0, 0, 0, 0.5)',
    '--islands-quick-row-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.7), rgba(var(--islands-effect-hover-surface-rgb), 0.5))',
    '--islands-quick-row-focus-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
    '--islands-sticky-shadow': '0 4px 8px -2px rgba(0, 0, 0, 0.4)',
    '--islands-terminal-border-left': '1px solid rgba(255, 255, 255, 0.06)',
  },
  abyss: {
    '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(var(--islands-accent-glow-rgb), 0))',
    '--islands-breathe-peak': 'drop-shadow(0 0 10px rgba(var(--islands-accent-glow-rgb), 0.42))',
    '--islands-aurora-primary': 'rgba(var(--islands-accent-glow-rgb), 0.42)',
    '--islands-aurora-secondary': 'rgba(var(--islands-accent-effect-rgb), 0.22)',
    '--islands-aurora-tail': 'rgba(var(--islands-accent-glow-rgb), 0.14)',
    '--islands-surface-border-top': '1px solid rgba(var(--islands-accent-effect-rgb), 0.12)',
    '--islands-surface-border-left': '1px solid rgba(var(--islands-accent-effect-rgb), 0.08)',
    '--islands-surface-border-bottom': '1px solid rgba(var(--islands-accent-glow-rgb), 0.03)',
    '--islands-surface-border-right': '1px solid rgba(var(--islands-accent-glow-rgb), 0.03)',
    '--islands-surface-shadow': '0 2px 10px 0 rgba(0, 0, 0, 0.48)',
    '--islands-elevated-border-top': '1px solid rgba(var(--islands-accent-effect-rgb), 0.16)',
    '--islands-elevated-border-left': '1px solid rgba(var(--islands-accent-effect-rgb), 0.1)',
    '--islands-elevated-border-bottom': '1px solid rgba(var(--islands-accent-glow-rgb), 0.04)',
    '--islands-elevated-border-right': '1px solid rgba(var(--islands-accent-glow-rgb), 0.04)',
    '--islands-list-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-border-rgb), 0.72), rgba(var(--islands-selection-inactive-rgb), 0.5))',
    '--islands-list-focus-selected-bg':
      'linear-gradient(135deg, rgba(var(--islands-border-rgb), 0.82), rgba(var(--islands-selection-inactive-rgb), 0.58))',
    '--islands-list-focus-active-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-strong-accent-rgb), 0.86), rgba(var(--islands-border-rgb), 0.62))',
    '--islands-list-hover-bg':
      'linear-gradient(135deg, rgba(var(--islands-border-rgb), 0.38), rgba(var(--islands-selection-inactive-rgb), 0.26))',
    '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.06)',
    '--islands-list-focus-selected-ring':
      'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.08)',
    '--islands-list-focus-active-ring':
      'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.1)',
    '--islands-tab-divider': 'var(--islands-border)',
    '--islands-tab-hover-text-shadow': '0 0 6px rgba(var(--islands-accent-effect-rgb), 0.22)',
    '--islands-hover-border': '1px solid rgba(var(--islands-accent-effect-rgb), 0.1)',
    '--islands-hover-shadow': '0 4px 18px 0 rgba(0, 0, 0, 0.52)',
    '--islands-activity-border-right': '1px solid rgba(var(--islands-accent-effect-rgb), 0.06)',
    '--islands-activity-shadow':
      'inset 0 1px 3px rgba(var(--islands-accent-effect-rgb), 0.08), 0 1px 5px #0000006b',
    '--islands-activity-hover-filter':
      'drop-shadow(0 0 6px rgba(var(--islands-accent-glow-rgb), 0.36))',
    '--islands-activity-checked-bg':
      'linear-gradient(180deg, rgba(var(--islands-border-rgb), 0.96), rgba(var(--islands-terminal-black-rgb), 0.78))',
    '--islands-activity-checked-shadow':
      'inset 0 1px 0 rgba(var(--islands-accent-effect-rgb), 0.14), 0 1px 4px #0000006b',
    '--islands-statusbar-hover': 'var(--islands-effect-status-hover)',
    '--islands-file-icon-filter': 'drop-shadow(0 0 3px currentColor)',
    '--islands-letterpress-opacity': '0.45',
    '--islands-letterpress-filter':
      'brightness(0) drop-shadow(2px 2px 1px rgba(var(--islands-accent-effect-rgb), 0.16))',
    '--islands-command-shadow':
      'inset 0 1px 0 rgba(var(--islands-accent-effect-rgb), 0.12), inset 1px 0 0 rgba(var(--islands-accent-effect-rgb), 0.06), 0 1px 4px #00000057',
    '--islands-notification-shadow': '0 4px 14px 0 rgba(0, 0, 0, 0.48)',
    '--islands-widget-large-shadow': '0 8px 28px 0 rgba(0, 0, 0, 0.58)',
    '--islands-quick-row-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-border-rgb), 0.78), rgba(var(--islands-selection-inactive-rgb), 0.56))',
    '--islands-quick-row-focus-ring':
      'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.08)',
    '--islands-sticky-shadow': '0 4px 9px -2px rgba(0, 0, 0, 0.48)',
    '--islands-terminal-border-left': '1px solid rgba(var(--islands-accent-effect-rgb), 0.08)',
  },
  pastel: {
    '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(var(--islands-accent-glow-rgb), 0))',
    '--islands-breathe-peak': 'drop-shadow(0 0 9px rgba(var(--islands-accent-glow-rgb), 0.36))',
    '--islands-aurora-primary': 'rgba(var(--islands-accent-glow-rgb), 0.38)',
    '--islands-aurora-secondary': 'rgba(var(--islands-accent-effect-rgb), 0.22)',
    '--islands-aurora-tail': 'rgba(var(--islands-accent-glow-rgb), 0.13)',
    '--islands-surface-border-top': '1px solid rgba(var(--islands-accent-effect-rgb), 0.12)',
    '--islands-surface-border-left': '1px solid rgba(var(--islands-accent-effect-rgb), 0.08)',
    '--islands-surface-border-bottom': '1px solid rgba(var(--islands-accent-glow-rgb), 0.03)',
    '--islands-surface-border-right': '1px solid rgba(var(--islands-accent-glow-rgb), 0.03)',
    '--islands-surface-shadow': '0 2px 9px 0 rgba(0, 0, 0, 0.42)',
    '--islands-elevated-border-top': '1px solid rgba(var(--islands-accent-effect-rgb), 0.14)',
    '--islands-elevated-border-left': '1px solid rgba(var(--islands-accent-effect-rgb), 0.09)',
    '--islands-elevated-border-bottom': '1px solid rgba(var(--islands-accent-glow-rgb), 0.04)',
    '--islands-elevated-border-right': '1px solid rgba(var(--islands-accent-glow-rgb), 0.04)',
    '--islands-list-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-selection-rgb), 0.81), rgba(var(--islands-hover-rgb), 0.57))',
    '--islands-list-focus-selected-bg':
      'linear-gradient(135deg, rgba(var(--islands-selection-rgb), 0.88), rgba(var(--islands-hover-rgb), 0.66))',
    '--islands-list-focus-active-bg':
      'linear-gradient(135deg, rgba(var(--islands-button-hover-rgb), 0.9), rgba(var(--islands-selection-rgb), 0.72))',
    '--islands-list-hover-bg':
      'linear-gradient(135deg, rgba(var(--islands-selection-rgb), 0.45), rgba(var(--islands-hover-rgb), 0.33))',
    '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.06)',
    '--islands-list-focus-selected-ring':
      'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.08)',
    '--islands-list-focus-active-ring':
      'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.1)',
    '--islands-tab-divider': 'var(--islands-border)',
    '--islands-tab-hover-text-shadow': '0 0 6px rgba(var(--islands-accent-effect-rgb), 0.2)',
    '--islands-hover-border': '1px solid rgba(var(--islands-accent-effect-rgb), 0.09)',
    '--islands-hover-shadow': '0 4px 16px 0 rgba(0, 0, 0, 0.46)',
    '--islands-activity-border-right': '1px solid rgba(var(--islands-accent-effect-rgb), 0.06)',
    '--islands-activity-shadow':
      'inset 0 1px 3px rgba(var(--islands-accent-effect-rgb), 0.08), 0 1px 4px #00000059',
    '--islands-activity-hover-filter':
      'drop-shadow(0 0 6px rgba(var(--islands-accent-glow-rgb), 0.32))',
    '--islands-activity-checked-bg':
      'linear-gradient(180deg, rgba(var(--islands-selection-rgb), 0.95), rgba(var(--islands-hover-rgb), 0.77))',
    '--islands-activity-checked-shadow':
      'inset 0 1px 0 rgba(var(--islands-accent-effect-rgb), 0.14), 0 1px 4px #00000059',
    '--islands-statusbar-hover': 'var(--islands-effect-status-hover)',
    '--islands-file-icon-filter': 'drop-shadow(0 0 3px currentColor)',
    '--islands-letterpress-opacity': '0.42',
    '--islands-letterpress-filter':
      'brightness(0) drop-shadow(2px 2px 1px rgba(var(--islands-accent-effect-rgb), 0.14))',
    '--islands-command-shadow':
      'inset 0 1px 0 rgba(var(--islands-accent-effect-rgb), 0.12), inset 1px 0 0 rgba(var(--islands-accent-effect-rgb), 0.06), 0 1px 4px #00000052',
    '--islands-notification-shadow': '0 4px 13px 0 rgba(0, 0, 0, 0.46)',
    '--islands-widget-large-shadow': '0 8px 26px 0 rgba(0, 0, 0, 0.54)',
    '--islands-quick-row-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-selection-rgb), 0.84), rgba(var(--islands-hover-rgb), 0.6))',
    '--islands-quick-row-focus-ring':
      'inset 0 0 0 1px rgba(var(--islands-accent-effect-rgb), 0.08)',
    '--islands-sticky-shadow': '0 4px 8px -2px rgba(0, 0, 0, 0.44)',
    '--islands-terminal-border-left': '1px solid rgba(var(--islands-accent-effect-rgb), 0.08)',
  },
  dawn: {
    '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(var(--islands-accent-glow-rgb), 0))',
    '--islands-breathe-peak': 'drop-shadow(0 0 8px rgba(var(--islands-accent-glow-rgb), 0.26))',
    '--islands-aurora-primary': 'rgba(var(--islands-accent-glow-rgb), 0.26)',
    '--islands-aurora-secondary': 'rgba(var(--islands-accent-effect-rgb), 0.15)',
    '--islands-aurora-tail': 'rgba(var(--islands-accent-glow-rgb), 0.08)',
    '--islands-surface-border-top': '1px solid rgba(255, 255, 255, 0.5)',
    '--islands-surface-border-left': '1px solid rgba(255, 255, 255, 0.3)',
    '--islands-surface-border-bottom': '1px solid rgba(0, 0, 0, 0.06)',
    '--islands-surface-border-right': '1px solid rgba(0, 0, 0, 0.04)',
    '--islands-surface-shadow': '0 2px 8px 0 rgba(0, 0, 0, 0.08)',
    '--islands-elevated-border-top': '1px solid rgba(255, 255, 255, 0.6)',
    '--islands-elevated-border-left': '1px solid rgba(255, 255, 255, 0.4)',
    '--islands-elevated-border-bottom': '1px solid rgba(0, 0, 0, 0.06)',
    '--islands-elevated-border-right': '1px solid rgba(0, 0, 0, 0.04)',
    '--islands-list-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.58), rgba(var(--islands-effect-hover-surface-rgb), 0.45))',
    '--islands-list-focus-selected-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.7), rgba(var(--islands-effect-hover-surface-rgb), 0.56))',
    '--islands-list-focus-active-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-active-surface-rgb), 0.68), rgba(var(--islands-effect-focus-surface-rgb), 0.56))',
    '--islands-list-hover-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.34), rgba(var(--islands-effect-hover-surface-rgb), 0.24))',
    '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.05)',
    '--islands-list-focus-selected-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.07)',
    '--islands-list-focus-active-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.08)',
    '--islands-tab-divider': 'var(--islands-border)',
    '--islands-tab-hover-text-shadow': '0 0 5px rgba(var(--islands-accent-glow-rgb), 0.14)',
    '--islands-hover-border': '1px solid rgba(0, 0, 0, 0.08)',
    '--islands-hover-shadow': '0 4px 16px 0 rgba(0, 0, 0, 0.1)',
    '--islands-activity-border-right': '1px solid rgba(0, 0, 0, 0.04)',
    '--islands-activity-shadow':
      'inset 0 1px 3px 0 rgba(255, 255, 255, 0.4), 0 1px 4px 0 rgba(0, 0, 0, 0.08)',
    '--islands-activity-hover-filter':
      'drop-shadow(0 0 5px rgba(var(--islands-accent-glow-rgb), 0.22))',
    '--islands-activity-checked-bg':
      'linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(var(--islands-effect-hover-surface-rgb), 0.74))',
    '--islands-activity-checked-shadow':
      'inset 0 1px 0 0 rgba(255, 255, 255, 0.6), inset 1px 0 0 0 rgba(255, 255, 255, 0.3), inset 0 -1px 0 0 rgba(0, 0, 0, 0.04), inset -1px 0 0 0 rgba(0, 0, 0, 0.03), inset 0 1px 2px 0 rgba(255, 255, 255, 0.3), 0 1px 3px 0 rgba(0, 0, 0, 0.1)',
    '--islands-statusbar-hover': 'var(--islands-effect-status-hover)',
    '--islands-file-icon-filter': 'drop-shadow(0 0 2px currentColor)',
    '--islands-letterpress-opacity': '0.3',
    '--islands-letterpress-filter':
      'brightness(1) drop-shadow(2px 2px 1px rgba(0, 0, 0, 0.08)) drop-shadow(-2px -2px 1px rgba(255, 255, 255, 0.6))',
    '--islands-command-shadow':
      'inset 0 1px 0 0 rgba(255, 255, 255, 0.5), inset 1px 0 0 0 rgba(255, 255, 255, 0.3), inset 0 -1px 0 0 rgba(0, 0, 0, 0.04), inset -1px 0 0 0 rgba(0, 0, 0, 0.03), inset 0 1px 3px 0 rgba(255, 255, 255, 0.25), 0 1px 4px 0 rgba(0, 0, 0, 0.06)',
    '--islands-notification-shadow': '0 4px 12px 0 rgba(0, 0, 0, 0.1)',
    '--islands-widget-large-shadow': '0 8px 24px 0 rgba(0, 0, 0, 0.12)',
    '--islands-quick-row-focus-bg':
      'linear-gradient(135deg, rgba(var(--islands-effect-focus-surface-rgb), 0.68), rgba(var(--islands-effect-hover-surface-rgb), 0.54))',
    '--islands-quick-row-focus-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
    '--islands-sticky-shadow': '0 4px 8px -2px rgba(0, 0, 0, 0.08)',
    '--islands-terminal-border-left': '1px solid rgba(0, 0, 0, 0.06)',
  },
};

module.exports = islandEffects;

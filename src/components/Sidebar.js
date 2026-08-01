import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  MessageSquare,
  Trash2,
  Sun,
  Moon,
  User,
  Car,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { formatDisplayName } from '../utils/usage';

const COLLAPSED_WIDTH = 56;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 280;
const STORAGE_KEY = 'vincritiq.sidebar.width';

function readStoredWidth() {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

export default function Sidebar({ onOpenSettings, onOpenAuth, collapsed, onToggle, hidden = false }) {
  const { user, userDoc } = useAuth();
  const { sessions, activeSessionId, loadSessions, loadSession, deleteSession, startNewChat, activeMode, renameSession } = useChat();
  // Inline rename state — { id, draft } when a session is being renamed,
  // null otherwise. Click the pencil → set this; Enter or blur saves,
  // Esc cancels.
  const [editing, setEditing] = useState(null);
  const editInputRef = useRef(null);
  // Two-step delete confirmation. First click on 🗑 puts that session
  // into `confirmingDelete`; the row morphs into "Delete this chat?
  // [Delete] [Cancel]" buttons. Second click on Delete actually deletes.
  // Hit Esc to cancel from anywhere. Prevents accidental data loss from
  // a misclick — particularly important since delete is permanent.
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  useEffect(() => {
    if (!confirmingDelete) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setConfirmingDelete(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingDelete]);
  // Filter the session list to chats from the currently active tab. Legacy
  // sessions without a `mode` field default to 'buy' so existing data still
  // shows up under the Buy tab.
  const visibleSessions = (sessions || []).filter(
    (s) => (s.mode || 'buy') === (activeMode || 'buy'),
  );
  const { dark, toggle } = useTheme();
  const [hoverId, setHoverId] = useState(null);
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (user) loadSessions();
  }, [user, loadSessions]);

  // Persist width whenever it changes (and we're not mid-drag spamming setItem)
  useEffect(() => {
    if (resizing) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {}
  }, [width, resizing]);

  // Drag-to-resize handlers
  const onResizeStart = useCallback((e) => {
    if (collapsed) return;
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    setResizing(true);
  }, [collapsed, width]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e) => {
      const delta = e.clientX - startXRef.current;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setWidth(next);
    };
    const onUp = () => setResizing(false);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  // `hidden` collapses the sidebar to width 0 — used by Find Me a Car
  // mode, which takes over the full canvas. The existing width transition
  // animates the slide-out cleanly.
  const effectiveWidth = hidden ? 0 : collapsed ? COLLAPSED_WIDTH : width;

  return (
    <div
      className="flex flex-col h-full relative"
      style={{
        width: effectiveWidth,
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        flexShrink: 0,
        transition: resizing ? 'none' : 'width 200ms ease',
      }}
    >
      {/* Header */}
      <div
        className="px-3 py-3 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--color-border)', minHeight: 56 }}
      >
        {collapsed ? (
          <button
            onClick={onToggle}
            className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors hover:opacity-80"
            style={{ color: 'var(--color-muted)' }}
            title="Open sidebar"
            aria-label="Open sidebar"
          >
            <PanelLeft size={18} />
          </button>
        ) : (
          <>
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0">
              <Car size={16} className="text-white" />
            </div>
            <span className="font-bold text-base flex-1 truncate" style={{ color: 'var(--color-text)' }}>
              VinCritiq
            </span>
            <button
              onClick={onToggle}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:opacity-80"
              style={{ color: 'var(--color-muted)' }}
              title="Close sidebar"
              aria-label="Close sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          </>
        )}
      </div>

      {/* New chat */}
      <div className="p-3">
        <button
          onClick={startNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
          style={{ background: 'var(--color-accent)', color: '#fff', justifyContent: collapsed ? 'center' : 'flex-start' }}
          title="New Assessment"
        >
          <Plus size={16} />
          {!collapsed && 'New Assessment'}
        </button>
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {!collapsed && visibleSessions.length > 0 && (
          <p className="px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            History
          </p>
        )}
        {!collapsed && visibleSessions.map(s => {
          const isEditing = editing?.id === s.id;
          const isConfirmingDelete = confirmingDelete === s.id;
          const startEdit = (e) => {
            e.stopPropagation();
            setEditing({ id: s.id, draft: s.title || '' });
            // Focus + select after the input mounts.
            setTimeout(() => {
              if (editInputRef.current) {
                editInputRef.current.focus();
                editInputRef.current.select();
              }
            }, 0);
          };
          const commitEdit = () => {
            if (!editing) return;
            const next = editing.draft.trim();
            if (next && next !== s.title) renameSession(s.id, next);
            setEditing(null);
          };
          const cancelEdit = () => setEditing(null);
          return (
            <div
              key={s.id}
              onMouseEnter={() => setHoverId(s.id)}
              onMouseLeave={() => setHoverId(null)}
              className="group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all"
              style={{
                background: activeSessionId === s.id ? 'var(--color-bg)' : 'transparent',
                color: 'var(--color-text)',
              }}
              onClick={() => { if (!isEditing) loadSession(s.id); }}
            >
              <MessageSquare size={14} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
              {isEditing ? (
                <>
                  <input
                    ref={editInputRef}
                    value={editing.draft}
                    onChange={e => setEditing({ ...editing, draft: e.target.value })}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                    }}
                    onBlur={commitEdit}
                    maxLength={80}
                    className="text-sm flex-1 bg-transparent outline-none border-b"
                    style={{
                      color: 'var(--color-text)',
                      borderColor: 'var(--color-accent)',
                      minWidth: 0,
                    }}
                  />
                  <button
                    onClick={e => { e.stopPropagation(); commitEdit(); }}
                    title="Save"
                    className="opacity-70 hover:opacity-100 transition-opacity"
                  >
                    <Check size={12} style={{ color: '#16a34a' }} />
                  </button>
                  <button
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); cancelEdit(); }}
                    title="Cancel"
                    className="opacity-70 hover:opacity-100 transition-opacity"
                  >
                    <X size={12} style={{ color: '#dc2626' }} />
                  </button>
                </>
              ) : isConfirmingDelete ? (
                <>
                  <span className="text-xs flex-1 truncate" style={{ color: '#dc2626' }}>
                    Delete this chat?
                  </span>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      deleteSession(s.id);
                      setConfirmingDelete(null);
                    }}
                    title="Confirm delete"
                    className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-opacity hover:opacity-80"
                    style={{ background: '#dc2626', color: '#fff' }}
                  >
                    Delete
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setConfirmingDelete(null); }}
                    title="Cancel"
                    className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80"
                    style={{
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-muted)',
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="text-sm flex-1 truncate" title={s.title || 'Assessment'}>
                    {s.title || 'Assessment'}
                  </span>
                  {hoverId === s.id && (
                    <>
                      <button
                        onClick={startEdit}
                        title="Rename"
                        className="opacity-60 hover:opacity-100 transition-opacity"
                      >
                        <Pencil size={12} style={{ color: 'var(--color-muted)' }} />
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          // First click arms the confirm state — second click
                          // (on the now-visible Delete button) actually deletes.
                          // This prevents accidental data loss from misclicks.
                          setConfirmingDelete(s.id);
                        }}
                        title="Delete"
                        className="opacity-60 hover:opacity-100 transition-opacity"
                      >
                        <Trash2 size={12} style={{ color: 'var(--color-muted)' }} />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
        {!collapsed && user && visibleSessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-center" style={{ color: 'var(--color-muted)' }}>
            {activeMode === 'sell'
              ? 'No sell-mode chats yet'
              : activeMode === 'find'
              ? 'No find-mode chats yet'
              : 'No assessments yet'}
          </p>
        )}
        {!collapsed && !user && (
          <p className="px-2 py-4 text-xs text-center" style={{ color: 'var(--color-muted)' }}>Sign in to save history</p>
        )}
      </div>

      {/* Bottom controls */}
      <div className="p-3 space-y-1" style={{ borderTop: '1px solid var(--color-border)' }}>
        <button
          onClick={toggle}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
          style={{ color: 'var(--color-muted)', justifyContent: collapsed ? 'center' : 'flex-start' }}
          title={dark ? 'Light mode' : 'Dark mode'}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
          {!collapsed && (dark ? 'Light mode' : 'Dark mode')}
        </button>

        {user ? (
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ color: 'var(--color-text)', justifyContent: collapsed ? 'center' : 'flex-start' }}
            title="Settings"
          >
            <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {(userDoc?.displayName || user.email || 'U')[0].toUpperCase()}
            </div>
            {!collapsed && (
              <span className="truncate text-sm">
                {formatDisplayName(userDoc?.displayName, user.email)}
              </span>
            )}
          </button>
        ) : (
          <button
            onClick={onOpenAuth}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ color: 'var(--color-muted)', justifyContent: collapsed ? 'center' : 'flex-start' }}
            title="Sign in"
          >
            <User size={16} />
            {!collapsed && 'Sign in'}
          </button>
        )}
      </div>

      {/* Drag handle (right edge) — hidden when collapsed */}
      {!collapsed && (
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 right-0 h-full"
          style={{
            width: 6,
            transform: 'translateX(50%)',
            cursor: 'col-resize',
            zIndex: 10,
          }}
          aria-label="Resize sidebar"
          role="separator"
        >
          <div
            className="h-full mx-auto transition-colors"
            style={{
              width: 2,
              background: resizing ? 'var(--color-accent)' : 'transparent',
            }}
          />
        </div>
      )}
    </div>
  );
}

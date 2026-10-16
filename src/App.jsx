import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, MessageCircle, Send, Trash2, UserPlus, UserCheck, Home, Users, Mail, LogOut, RefreshCw, Search, Sparkles, Bell, Sun, Moon, User, Pencil, GraduationCap, BookOpen, Cake, MapPin, Calendar, Camera, ImagePlus, X, MoreHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from './lib/supabase.js';
import { AVATAR_BUCKET, POST_IMAGE_BUCKET, isImageFile, publicUrl, shrinkImage, uploadImage, removeImage, removeImages, postImagePaths } from './images.js';
import { translate, initialLang, saveLang } from './i18n.js';
import { initialTheme, saveTheme } from './theme.js';

const MAX_POST = 500;
const MAX_COMMENT = 300;
const MAX_MESSAGE = 1000;
const MAX_IMAGES = 4; // per post (enforced in supabase/migrations/0006_post_editing.sql)
// Only school accounts may join. The database enforces this too (supabase/migrations/0002_restrict_email_domain.sql).
const SCHOOL_DOMAIN = 'osfl.ac.jp';
const isSchoolEmail = value => value.trim().toLowerCase().endsWith(`@${SCHOOL_DOMAIN}`);
const stamp = (value, lang) => new Date(value).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
const snip = (text, max = 70) => (text.length > max ? `${text.slice(0, max).trimEnd()}...` : text);
const display = profile => profile?.display_name || profile?.handle || 'Member';
function Avatar({ profile, large }) {
  const [failed, setFailed] = useState('');
  const className = `avatar ${large ? 'avatar-lg' : ''}`;
  const path = profile?.avatar_path;
  // Show the profile photo if there is one; fall back to the first letter if it can't load.
  if (path && failed !== path) return <img className={className} src={publicUrl(AVATAR_BUCKET, path)} alt="" loading="lazy" onError={() => setFailed(path)}/>;
  return <span className={className} aria-hidden="true">{display(profile).slice(0, 1).toUpperCase()}</span>;
}
// Birthdays are stored as YYYY-MM-DD; show only month and day, and avoid timezone shifts.
const birthdayText = (value, lang) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
};
const mergeRows = (prev, rows, key) => [...new Map([...prev, ...rows].map(r => [r[key], r])).values()];
const HANDLE_RE = /^[a-z][a-z0-9_]{2,33}$/;
const EMPTY_FORM = { display_name: '', handle: '', school: '', course: '', year: '', gender: '', birthday: '', hometown: '', bio: '' };
// A person's avatar and/or name, clickable to open their profile.
function PersonLink({ onOpen, title, className = '', children }) {
  return <button type="button" className={`person-link ${className}`} onClick={onOpen} title={title}>{children}</button>;
}
function ConfirmDialog({ message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return <div className="modal-backdrop" onClick={onCancel}>
    <div className="modal panel" role="alertdialog" aria-modal="true" aria-label={message} onClick={e => e.stopPropagation()}>
      <p>{message}</p>
      <div className="form-actions-inline"><button className="secondary" autoFocus onClick={onCancel}>{cancelLabel}</button><button className="danger-button" onClick={onConfirm}>{confirmLabel}</button></div>
    </div>
  </div>;
}
function Lightbox({ t, urls, index, onIndex, onClose }) {
  const many = urls.length > 1;
  const go = step => onIndex((index + step + urls.length) % urls.length);
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      if (many && e.key === 'ArrowRight') onIndex((index + 1) % urls.length);
      if (many && e.key === 'ArrowLeft') onIndex((index - 1 + urls.length) % urls.length);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, many, urls.length, onIndex, onClose]);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('postImageAlt')} onClick={onClose}>
    <img src={urls[index]} alt={t('postImageAlt')} onClick={e => e.stopPropagation()}/>
    <button className="lightbox-btn close" onClick={onClose} aria-label={t('close')} title={t('close')}><X size={22}/></button>
    {many && <>
      <button className="lightbox-btn prev" onClick={e => { e.stopPropagation(); go(-1); }} aria-label={t('previousImage')} title={t('previousImage')}><ChevronLeft size={26}/></button>
      <button className="lightbox-btn next" onClick={e => { e.stopPropagation(); go(1); }} aria-label={t('nextImage')} title={t('nextImage')}><ChevronRight size={26}/></button>
      <span className="lightbox-count">{index + 1} / {urls.length}</span>
    </>}
  </div>;
}
function ThemeToggle({ t, theme, onToggle }) {
  const label = theme === 'dark' ? t('lightMode') : t('darkMode');
  return <button type="button" className="icon-button theme-toggle" onClick={onToggle} aria-label={label} title={label}>{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</button>;
}
function LangToggle({ t, lang, onChange }) {
  return <div className="lang-switch" role="group" aria-label={t('language')}>
    {[['en', 'EN'], ['ja', '日本語']].map(([code, label]) => <button key={code} type="button" lang={code} className={lang === code ? 'active' : ''} aria-pressed={lang === code} onClick={() => onChange(code)}>{label}</button>)}
  </div>;
}

function Auth({ notify, t, lang, onChangeLang, theme, onToggleTheme }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setError('');
    const h = handle.trim().toLowerCase();
    if (!isSchoolEmail(email)) { setError(t('errSchoolEmail', { example: `w25009@${SCHOOL_DOMAIN}` })); return; }
    if (signup && (!/^[a-z][a-z0-9_]{2,33}$/.test(h) || !name.trim())) {
      setError(t('errSignupFields')); return;
    }
    setBusy(true);
    try {

      const result = signup
        ? await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim(), handle: h } } })
        : await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      // With email confirmation on, Supabase returns a fake success (a user with no identities) for an email that's already registered.
      if (signup && result.data.user?.identities?.length === 0) {
        setError(t('errEmailExists')); setSignup(false); return;
      }
      if (signup && !result.data.session) notify(t('signupDone'));
    } catch (err) {
      if (signup && /already registered/i.test(err.message || '')) { setError(t('errEmailExists')); setSignup(false); }
      else setError(err.message || t('errContinue'));
    }
    finally { setBusy(false); }
  }
  return <div className="auth-wrap"><div className="auth-card">
    <div className="auth-top"><div className="brand">CampConnect</div><div className="prefs"><LangToggle t={t} lang={lang} onChange={onChangeLang}/><ThemeToggle t={t} theme={theme} onToggle={onToggleTheme}/></div></div>
    <h1>{signup ? t('createAccountTitle') : t('tagline')}</h1>
    {signup && <p className="muted">{t('signupSubtitle')}</p>}
    <form className="stack-form" onSubmit={submit}>
      {signup && <><label>{t('displayName')}<input required maxLength={60} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label><label>{t('username')}<input required minLength={3} maxLength={34} autoComplete="username" value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} placeholder="your_username" /></label><p className="muted">{t('usernameHint')}</p></>}
      <label>{t('schoolEmail')}<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={`w25000@${SCHOOL_DOMAIN}`} /></label>
      <label>{t('password')}<input required type="password" minLength={6} autoComplete={signup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? t('pleaseWait') : signup ? t('createAccount') : t('signIn')}</button>
    </form>
    <button className="text-button" onClick={() => { setSignup(!signup); setError(''); }}>{signup ? t('haveAccount') : t('newHere')}</button>
  </div></div>;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('feed');
  const [profiles, setProfiles] = useState([]);
  const [posts, setPosts] = useState([]);
  const [likes, setLikes] = useState([]);
  const [counts, setCounts] = useState([]);
  const [commentsByPost, setCommentsByPost] = useState({});
  const [loadingComments, setLoadingComments] = useState({});
  const [searchResults, setSearchResults] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [searching, setSearching] = useState(false);
  const [follows, setFollows] = useState([]);
  const [messages, setMessages] = useState([]);
  const [recipient, setRecipient] = useState('');
  const [query, setQuery] = useState('');
  const [postText, setPostText] = useState('');
  const [postImages, setPostImages] = useState([]); // [{ file, preview }] picked in the composer
  const postImageInput = useRef(null);
  const editImageInput = useRef(null);
  const [menuPost, setMenuPost] = useState(''); // post whose ⋯ menu is open
  const [editingPost, setEditingPost] = useState(null); // { id, body, keep, added, original }
  const [confirmBox, setConfirmBox] = useState(null); // { message, confirmLabel, onConfirm }
  const [lightbox, setLightbox] = useState(null); // { paths, index }
  // Our own confirm dialog: the browser's confirm() is blocked in some browsers.
  const askConfirm = (message, confirmLabel, onConfirm) => setConfirmBox({ message, confirmLabel, onConfirm });
  useEffect(() => {
    if (!menuPost) return undefined;
    const close = () => setMenuPost('');
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuPost]);
  const avatarInput = useRef(null);
  const [messageText, setMessageText] = useState('');
  const [commentText, setCommentText] = useState({});
  const [openComments, setOpenComments] = useState({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Notifications: who follows me, messages sent to me, and what I've already seen (kept per browser).
  const [followers, setFollowers] = useState(null);
  const [incoming, setIncoming] = useState([]);
  const [notifyProfiles, setNotifyProfiles] = useState([]);
  const [seen, setSeen] = useState(null);
  const [newFollowerIds, setNewFollowerIds] = useState([]);
  const [activity, setActivity] = useState({ likes: [], comments: [], posts: [] });
  const [freshNotifs, setFreshNotifs] = useState([]);
  const [lang, setLang] = useState(initialLang);
  const t = (key, vars) => translate(lang, key, vars);
  const when = value => stamp(value, lang);
  const langRef = useRef(lang);
  langRef.current = lang;
  const changeLang = next => { setLang(next); saveLang(next); };
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const [theme, setTheme] = useState(initialTheme);
  const toggleTheme = () => setTheme(prev => { const next = prev === 'dark' ? 'light' : 'dark'; saveTheme(next); return next; });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  // Profile page: whose profile is open, its data, and the edit form.
  const [viewProfileId, setViewProfileId] = useState('');
  const [profileView, setProfileView] = useState({ id: '', data: null, posts: [], followers: 0, following: 0, loading: false });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [flash, setFlash] = useState('');
  const profileRequest = useRef(0);
  useEffect(() => { if (!flash) return undefined; const timer = setTimeout(() => setFlash(''), 3000); return () => clearTimeout(timer); }, [flash]);
  const userId = session?.user?.id;
  const messageRequest = useRef(0);
  const recipientRef = useRef('');
  useEffect(() => {
    if (!supabase) { setChecking(false); return; }
    let active = true;
    supabase.auth.getSession().then(({ data, error: err }) => {
      if (active) { if (err) setError(err.message); setSession(data.session); setChecking(false); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) { setSession(next); setChecking(false); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  // Accounts made before the school-email rule (e.g. Gmail) are signed straight back out.
  const rejectAccount = useCallback(async key => {
    await supabase.auth.signOut();
    setNotice(translate(langRef.current, key));
  }, []);
  useEffect(() => {
    if (session && !isSchoolEmail(session.user?.email || '')) rejectAccount('errNotSchoolAccount');
  }, [session, rejectAccount]);
  const loadCommunity = useCallback(async (spin = false) => {
    if (!userId) return;
    if (spin) setLoading(true);
    try {
      const [postResult, recentProfiles, followResult] = await Promise.all([
        supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(100),
        supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('follows').select('follower_id,following_id').eq('follower_id', userId),
      ]);
      const firstError = [postResult, recentProfiles, followResult].find(r => r.error);
      if (firstError) throw firstError.error;
      const postRows = postResult.data || [];
      const ids = postRows.map(p => p.id);
      const authorIds = [...new Set([...postRows.map(p => p.author_id), userId])];
      const [authorResult, countResult, likeResult] = await Promise.all([
        supabase.from('profiles').select('*').in('id', authorIds),
        ids.length ? supabase.from('post_counts').select('post_id,like_count,comment_count').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('likes').select('post_id,user_id').eq('user_id', userId).in('post_id', ids) : Promise.resolve({ data: [], error: null }),
      ]);
      const secondError = [authorResult, countResult, likeResult].find(r => r.error);
      if (secondError) throw secondError.error;
      // Every real member has a profile (created at sign-up). Without one, the account wasn't set up properly.
      if (!(authorResult.data || []).some(p => p.id === userId)) { await rejectAccount('errNoProfile'); return; }
      const byId = new Map([...(recentProfiles.data || []), ...(authorResult.data || [])].map(p => [p.id, p]));
      setProfiles([...byId.values()]); setPosts(postRows);
      setCounts(countResult.data || []); setLikes(likeResult.data || []);
      setFollows(followResult.data || []); setError('');
    } catch (err) { setError(err.message || translate(langRef.current, 'errLoadCommunity')); }
    finally { if (spin) setLoading(false); }
  }, [userId, rejectAccount]);
  const loadComments = useCallback(async postId => {
    setLoadingComments(prev => ({ ...prev, [postId]: true }));
    const { data, error: err } = await supabase.from('comments')
      .select('id,post_id,author_id,body,created_at')
      .eq('post_id', postId).order('created_at', { ascending: false }).limit(100);
    if (err) { setError(err.message); }
    else {
      const rows = (data || []).reverse();
      setCommentsByPost(prev => ({ ...prev, [postId]: rows }));
      const authorIds = [...new Set(rows.map(c => c.author_id))];
      if (authorIds.length) {
        const { data: authors, error: authorError } = await supabase.from('profiles')
          .select('*').in('id', authorIds);
        if (authorError) setError(authorError.message);
        else setProfiles(prev => [...new Map([...prev, ...(authors || [])].map(p => [p.id, p])).values()]);
      }
    }
    setLoadingComments(prev => ({ ...prev, [postId]: false }));
  }, []);
  const loadMessages = useCallback(async () => {
    if (!userId || !recipient) { setMessages([]); return; }
    const requestId = ++messageRequest.current;
    const { data, error: err } = await supabase.from('direct_messages')
      .select('id,sender_id,recipient_id,body,created_at')
      .or(`and(sender_id.eq.${userId},recipient_id.eq.${recipient}),and(sender_id.eq.${recipient},recipient_id.eq.${userId})`)
      .order('created_at', { ascending: false }).limit(200);
    if (requestId !== messageRequest.current || recipient !== recipientRef.current) return;
    if (err) setError(err.message); else { setMessages((data || []).reverse()); setError(''); }
  }, [userId, recipient]);
  const loadProfile = useCallback(async id => {
    if (!userId || !id) return;
    const requestId = ++profileRequest.current;
    const [profileResult, postResult, followerResult, followingResult] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).maybeSingle(),
      supabase.from('posts').select('*').eq('author_id', id).order('created_at', { ascending: false }).limit(50),
      supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', id),
      supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', id),
    ]);
    if (requestId !== profileRequest.current) return;
    const failed = [profileResult, postResult, followerResult, followingResult].find(r => r.error);
    if (failed) { setError(failed.error.message); setProfileView(v => ({ ...v, loading: false })); return; }
    const postRows = postResult.data || [];
    const ids = postRows.map(p => p.id);
    // Older posts may not be in the feed, so fetch their like/comment counts and my likes too.
    if (ids.length) {
      const [countResult, likeResult] = await Promise.all([
        supabase.from('post_counts').select('post_id,like_count,comment_count').in('post_id', ids),
        supabase.from('likes').select('post_id,user_id').eq('user_id', userId).in('post_id', ids),
      ]);
      if (requestId !== profileRequest.current) return;
      if (!countResult.error) setCounts(prev => mergeRows(prev, countResult.data || [], 'post_id'));
      if (!likeResult.error) setLikes(prev => [...prev.filter(l => !ids.includes(l.post_id)), ...(likeResult.data || [])]);
    }
    if (profileResult.data) setProfiles(prev => mergeRows(prev, [profileResult.data], 'id'));
    setProfileView({ id, data: profileResult.data, posts: postRows, followers: followerResult.count ?? 0, following: followingResult.count ?? 0, loading: false });
  }, [userId]);
  const loadNotifications = useCallback(async () => {
    if (!userId) return;
    const [followerResult, inboxResult, likeResult, commentResult, postResult] = await Promise.all([
      supabase.from('follows').select('follower_id').eq('following_id', userId),
      supabase.from('direct_messages').select('sender_id,created_at').eq('recipient_id', userId).order('created_at', { ascending: false }).limit(500),
      // Likes and comments on my posts (the !inner join keeps only rows whose post I wrote).
      supabase.from('likes').select('post_id,user_id,posts!inner(author_id,body)').eq('posts.author_id', userId).neq('user_id', userId).limit(500),
      supabase.from('comments').select('id,post_id,author_id,body,created_at,posts!inner(author_id)').eq('posts.author_id', userId).neq('author_id', userId).order('created_at', { ascending: false }).limit(100),
      supabase.from('posts').select('*').neq('author_id', userId).order('created_at', { ascending: false }).limit(50),
    ]);
    const failed = [followerResult, inboxResult, likeResult, commentResult, postResult].find(r => r.error);
    if (failed) { setError(failed.error.message); return; }
    const followerIds = (followerResult.data || []).map(f => f.follower_id);
    const inbox = inboxResult.data || [];
    const likeRows = likeResult.data || [];
    setFollowers(followerIds); setIncoming(inbox);
    setActivity({ likes: likeRows, comments: commentResult.data || [], posts: postResult.data || [] });
    // Likes and follows have no timestamp in the database, so remember when this browser first saw each one.
    const untimedKeys = [...likeRows.map(l => `like:${l.post_id}:${l.user_id}`), ...followerIds.map(id => `follow:${id}`)];
    setSeen(s => {
      if (!s) return s;
      const known = s.firstSeen;
      if (known && untimedKeys.length === Object.keys(known).length && untimedKeys.every(k => k in known)) return s;
      const now = new Date().toISOString();
      return { ...s, firstSeen: Object.fromEntries(untimedKeys.map(k => [k, k in (known || {}) ? known[k] : (known ? now : null)])) };
    });
    const peopleIds = [...new Set([...followerIds, ...inbox.map(m => m.sender_id), ...likeRows.map(l => l.user_id), ...(commentResult.data || []).map(c => c.author_id), ...(postResult.data || []).map(p => p.author_id)])];
    if (peopleIds.length) {
      const { data, error: err } = await supabase.from('profiles').select('*').in('id', peopleIds);
      if (!err) setNotifyProfiles(data || []);
    }
  }, [userId]);
  useEffect(() => { if (userId) loadCommunity(true); else { setProfiles([]); setPosts([]); setMessages([]); } }, [userId, loadCommunity]);
  useEffect(() => {
    setFollowers(null); setIncoming([]); setNotifyProfiles([]); setNewFollowerIds([]); setActivity({ likes: [], comments: [], posts: [] }); setFreshNotifs([]);
    if (!userId) { setSeen(null); return; }
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(`campconnect_seen_${userId}`)); } catch { stored = null; }
    // First visit on this browser: start counting from now so old activity doesn't flood the badges.
    setSeen(stored?.since ? stored : { since: new Date().toISOString(), followers: null, senders: {} });
    loadNotifications();
  }, [userId, loadNotifications]);
  useEffect(() => {
    if (!userId || !seen) return;
    try { localStorage.setItem(`campconnect_seen_${userId}`, JSON.stringify(seen)); } catch { /* storage unavailable */ }
  }, [userId, seen]);
  useEffect(() => { if (seen && followers && seen.followers === null) setSeen(s => ({ ...s, followers })); }, [seen, followers]);
  useEffect(() => { recipientRef.current = recipient; messageRequest.current += 1; setMessages([]); }, [recipient, userId]);
  useEffect(() => { if (tab === 'messages') loadMessages(); }, [tab, loadMessages]);
  useEffect(() => {
    if (tab !== 'profile' || !viewProfileId) return;
    setProfileView(v => (v.id === viewProfileId ? { ...v, loading: true } : { id: viewProfileId, data: null, posts: [], followers: 0, following: 0, loading: true }));
    loadProfile(viewProfileId);
  }, [tab, viewProfileId, loadProfile]);
  useEffect(() => {
    if (!userId || tab !== 'people' || !query.trim()) { setSearchResults([]); setSearching(false); return undefined; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const term = query.trim().replace(/[^a-zA-Z0-9_ ]/g, '');
      if (!term) { if (!cancelled) { setSearchResults([]); setSearching(false); } return; }
      const { data, error: searchError } = await supabase.from('profiles')
        .select('*')
        .or(`handle.ilike.%${term}%,display_name.ilike.%${term}%`)
        .order('created_at', { ascending: false }).limit(50);
      if (!cancelled) {
        if (searchError) setError(searchError.message);
        else setSearchResults(data || []);
        setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [userId, tab, query]);
  useEffect(() => {
    if (!userId) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') { loadNotifications(); if (tab === 'messages') loadMessages(); } }, 15000);
    return () => clearInterval(timer);
  }, [userId, tab, loadMessages, loadNotifications]);
  const unreadBySender = useMemo(() => {
    const counts = {};
    if (!seen) return counts;
    for (const m of incoming) {
      if (Date.parse(m.created_at) > Date.parse(seen.senders[m.sender_id] || seen.since)) counts[m.sender_id] = (counts[m.sender_id] || 0) + 1;
    }
    return counts;
  }, [incoming, seen]);
  const unreadMessages = Object.values(unreadBySender).reduce((a, b) => a + b, 0);
  const unseenFollowers = useMemo(() => (followers && seen?.followers ? followers.filter(id => !seen.followers.includes(id)) : []), [followers, seen]);
  // Opening People marks new followers as seen, but keeps their "New follower" tag until you leave the tab.
  useEffect(() => {
    if (tab !== 'people') { setNewFollowerIds([]); return; }
    if (!unseenFollowers.length) return;
    setNewFollowerIds(prev => [...new Set([...prev, ...unseenFollowers])]);
    setSeen(s => ({ ...s, followers: [...new Set([...(s.followers || []), ...unseenFollowers])] }));
  }, [tab, unseenFollowers]);
  // Viewing a conversation marks that person's messages as read.
  useEffect(() => {
    if (tab !== 'messages' || !recipient || !unreadBySender[recipient]) return;
    const latest = incoming.find(m => m.sender_id === recipient)?.created_at;
    if (latest) setSeen(s => ({ ...s, senders: { ...s.senders, [recipient]: latest } }));
  }, [tab, recipient, unreadBySender, incoming]);
  const notifications = useMemo(() => {
    if (!seen) return [];
    const readAt = Date.parse(seen.notifAt || seen.since);
    const isNew = at => !!at && Date.parse(at) > readAt;
    const list = [
      ...activity.likes.map(l => { const key = `like:${l.post_id}:${l.user_id}`; const at = seen.firstSeen?.[key]; return { key, kind: 'like', actor: l.user_id, postId: l.post_id, text: l.posts?.body, at, unread: isNew(at) }; }),
      ...activity.comments.map(c => ({ key: `comment:${c.id}`, kind: 'comment', actor: c.author_id, postId: c.post_id, text: c.body, at: c.created_at, unread: isNew(c.created_at) })),
      ...activity.posts.map(p => ({ key: `post:${p.id}`, kind: 'post', actor: p.author_id, postId: p.id, text: p.body, at: p.created_at, unread: isNew(p.created_at) })),
      ...(followers || []).map(id => { const key = `follow:${id}`; return { key, kind: 'follow', actor: id, at: seen.firstSeen?.[key], unread: !!seen.followers && !seen.followers.includes(id) }; }),
    ];
    return list.sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0)).slice(0, 80);
  }, [activity, followers, seen]);
  const unreadNotifications = notifications.filter(n => n.unread).length;
  // Opening Notifications marks everything as read, but keeps the highlight until you leave the tab.
  useEffect(() => {
    if (tab !== 'notifications') { setFreshNotifs([]); return; }
    const unread = notifications.filter(n => n.unread);
    if (!unread.length) return;
    setFreshNotifs(prev => [...new Set([...prev, ...unread.map(n => n.key)])]);
    // Use the newest item time if it's ahead of this computer's clock, so nothing stays stuck as unread.
    const newest = Math.max(Date.now(), ...unread.map(n => Date.parse(n.at) || 0));
    setSeen(s => ({ ...s, notifAt: new Date(newest).toISOString(), followers: [...new Set([...(s.followers || []), ...(followers || [])])] }));
  }, [tab, notifications, followers]);
  const profileMap = useMemo(() => new Map([...notifyProfiles, ...profiles, ...searchResults, ...(selectedProfile ? [selectedProfile] : [])].map(p => [p.id, p])), [notifyProfiles, profiles, searchResults, selectedProfile]);
  const mine = profileMap.get(userId);
  const followingIds = new Set(follows.map(f => f.following_id));
  const followerIds = new Set(followers || []);
  const others = [...new Map([...notifyProfiles, ...profiles, ...searchResults, ...(selectedProfile ? [selectedProfile] : [])].filter(p => p.id !== userId).map(p => [p.id, p])).values()];
  const filtered = (query.trim() ? searchResults.filter(p => p.id !== userId) : others)
    .sort((a, b) => newFollowerIds.includes(b.id) - newFollowerIds.includes(a.id));
  const contacts = [...others].sort((a, b) => (unreadBySender[b.id] || 0) - (unreadBySender[a.id] || 0));
  const badges = { notifications: unreadNotifications, people: unseenFollowers.length, messages: unreadMessages };
  const badgeText = n => (n > 99 ? '99+' : n);
  async function mutate(key, operation, after) {
    setBusy(key); setError('');
    try {
      const result = await operation();
      if (result.error) throw result.error;
      if (after) after();
      await loadCommunity();
      if (tab === 'profile' && viewProfileId) await loadProfile(viewProfileId);
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  // Storage missing (0005 not run yet) shows a setup hint instead of a raw error.
  const imageErrorText = err => (/bucket not found|image_path|avatar_path|PGRST204|42703/i.test(`${err?.message} ${err?.code}`) ? t('errImageSetup') : err?.message || t('errAction'));
  const editErrorText = err => (/image_paths|PGRST204|42501|42703/i.test(`${err?.message} ${err?.code}`) ? t('errEditSetup') : imageErrorText(err));
  // Turn picked files into previews, keeping the total at MAX_IMAGES.
  function pickImages(e, existingCount, add) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    if (files.some(f => !isImageFile(f))) { setError(t('errImageType')); return; }
    const room = MAX_IMAGES - existingCount;
    if (files.length > room) setError(t('imagesLimit', { n: MAX_IMAGES }));
    if (room > 0) add(files.slice(0, room).map(file => ({ file, preview: URL.createObjectURL(file) })));
  }
  const dropPreviews = items => items.forEach(item => URL.revokeObjectURL(item.preview));
  const removePostImage = index => setPostImages(prev => { dropPreviews([prev[index]]); return prev.filter((_, i) => i !== index); });
  async function uploadPostImages(items) {
    const paths = [];
    try {
      for (const item of items) paths.push(await uploadImage(POST_IMAGE_BUCKET, userId, await shrinkImage(item.file, 1600)));
      return paths;
    } catch (err) { await removeImages(POST_IMAGE_BUCKET, paths); throw err; }
  }
  async function publish(e) {
    e.preventDefault(); const body = postText.trim();
    if ((!body && !postImages.length) || body.length > MAX_POST) return;
    setBusy('post'); setError('');
    let paths = [];
    try {
      paths = await uploadPostImages(postImages);
      let { error: err } = await supabase.from('posts').insert(paths.length ? { author_id: userId, body, image_paths: paths } : { author_id: userId, body });
      // Before 0006 there is only the single image_path column; a one-image post still works then.
      if (err?.code === 'PGRST204' && paths.length === 1) ({ error: err } = await supabase.from('posts').insert({ author_id: userId, body, image_path: paths[0] }));
      if (err) throw err;
      setPostText(''); dropPreviews(postImages); setPostImages([]);
      await loadCommunity();
    } catch (err) {
      await removeImages(POST_IMAGE_BUCKET, paths); // don't leave orphaned files behind
      setError(paths.length > 1 ? editErrorText(err) : imageErrorText(err));
    } finally { setBusy(''); }
  }
  const deletePost = post => mutate('delete', async () => {
    const result = await supabase.from('posts').delete().eq('id', post.id);
    if (!result.error) await removeImages(POST_IMAGE_BUCKET, postImagePaths(post));
    return result;
  });
  function startEditPost(post) {
    setMenuPost('');
    setEditingPost({ id: post.id, body: post.body || '', keep: postImagePaths(post), added: [], original: postImagePaths(post) });
  }
  function cancelEditPost() {
    if (editingPost) dropPreviews(editingPost.added);
    setEditingPost(null);
  }
  async function saveEditPost(e) {
    e.preventDefault();
    const { id, keep, added, original } = editingPost;
    const body = editingPost.body.trim();
    if ((!body && !keep.length && !added.length) || body.length > MAX_POST) return;
    setBusy('edit'); setError('');
    let newPaths = [];
    try {
      newPaths = await uploadPostImages(added);
      const { data, error: err } = await supabase.from('posts').update({ body, image_paths: [...keep, ...newPaths], image_path: null }).eq('id', id).select('id');
      if (err) throw err;
      if (!data?.length) throw { code: '42501' }; // no row changed: editing isn't allowed yet (0006 not run)
      await removeImages(POST_IMAGE_BUCKET, original.filter(p => !keep.includes(p)));
      dropPreviews(added); setEditingPost(null);
      await loadCommunity();
      if (tab === 'profile' && viewProfileId) await loadProfile(viewProfileId);
    } catch (err) {
      await removeImages(POST_IMAGE_BUCKET, newPaths);
      setError(editErrorText(err));
    } finally { setBusy(''); }
  }
  async function changeAvatar(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (!isImageFile(file)) { setError(t('errImageType')); return; }
    const oldPath = profileView.data?.avatar_path;
    setBusy('photo'); setError('');
    let newPath = null;
    try {
      newPath = await uploadImage(AVATAR_BUCKET, userId, await shrinkImage(file, 512, true));
      const { error: err } = await supabase.from('profiles').update({ avatar_path: newPath }).eq('id', userId);
      if (err) throw err;
      if (oldPath) removeImage(AVATAR_BUCKET, oldPath);
      setFlash(t('photoUpdated'));
      await Promise.all([loadProfile(userId), loadCommunity()]);
    } catch (err) {
      if (newPath) removeImage(AVATAR_BUCKET, newPath);
      setError(imageErrorText(err));
    } finally { setBusy(''); }
  }
  async function removeAvatar() {
    const oldPath = profileView.data?.avatar_path;
    if (!oldPath) return;
    setBusy('photo'); setError('');
    const { error: err } = await supabase.from('profiles').update({ avatar_path: null }).eq('id', userId);
    setBusy('');
    if (err) { setError(imageErrorText(err)); return; }
    removeImage(AVATAR_BUCKET, oldPath);
    await Promise.all([loadProfile(userId), loadCommunity()]);
  }
  function addComment(e, id) {
    e.preventDefault(); const body = (commentText[id] || '').trim();
    if (!body || body.length > MAX_COMMENT) return;
    setBusy('comment'); setError('');
    supabase.from('comments').insert({ post_id: id, author_id: userId, body }).then(async ({ error: err }) => {
      if (err) setError(err.message);
      else {
        setCommentText(prev => ({ ...prev, [id]: '' }));
        await Promise.all([loadComments(id), loadCommunity()]);
      }
      setBusy('');
    });
  }
  async function sendMessage(e) {
    e.preventDefault(); const body = messageText.trim();
    if (!recipient || !body || body.length > MAX_MESSAGE) return;
    setBusy('message'); setError('');
    try {
      const { error: err } = await supabase.from('direct_messages').insert({ sender_id: userId, recipient_id: recipient, body });
      if (err) throw err;
      setMessageText(''); await loadMessages();
    } catch (err) { setError(err.message || t('errMessage')); }
    finally { setBusy(''); }
  }
  async function openNotification(n) {
    if (n.kind === 'follow') { setTab('people'); return; }
    setTab('feed');
    if (n.kind === 'comment') { setOpenComments(prev => ({ ...prev, [n.postId]: true })); loadComments(n.postId); }
    await loadCommunity();
    requestAnimationFrame(() => document.getElementById(`post-${n.postId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
  function openProfile(id) {
    if (!id) return;
    setViewProfileId(id); setEditing(false); setTab('profile');
    window.scrollTo({ top: 0 });
  }
  function openConversation(p) {
    messageRequest.current += 1; setMessages([]); setSelectedProfile(p); setRecipient(p.id); setTab('messages');
  }
  const toggleFollow = id => mutate('follow', () => (followingIds.has(id)
    ? supabase.from('follows').delete().eq('follower_id', userId).eq('following_id', id)
    : supabase.from('follows').insert({ follower_id: userId, following_id: id })));
  function startEdit() {
    const p = profileView.data || {};
    setForm(Object.fromEntries(Object.keys(EMPTY_FORM).map(k => [k, p[k] == null ? '' : String(p[k])])));
    setEditing(true);
  }
  const setField = key => e => setForm(prev => ({ ...prev, [key]: e.target.value }));
  async function saveProfile(e) {
    e.preventDefault(); setError('');
    const handle = form.handle.trim().toLowerCase();
    if (!form.display_name.trim() || !HANDLE_RE.test(handle)) { setError(t('errSignupFields')); return; }
    const orNull = v => (v.trim() ? v.trim() : null);
    setBusy('profile');
    const { error: err } = await supabase.from('profiles').update({
      display_name: form.display_name.trim(), handle,
      school: form.school || null, course: orNull(form.course), year: form.year ? Number(form.year) : null,
      gender: form.gender || null, birthday: form.birthday || null, hometown: orNull(form.hometown), bio: orNull(form.bio),
    }).eq('id', userId);
    setBusy('');
    if (err) {
      if (err.code === '23505') setError(t('errHandleTaken'));
      else if (err.code === 'PGRST204' || err.code === '42703') setError(t('errProfileColumns'));
      else setError(err.message);
      return;
    }
    setEditing(false); setFlash(t('profileSaved'));
    await Promise.all([loadProfile(userId), loadCommunity()]);
  }
  // A person's avatar + name, clickable to open their profile.
  const linkProps = id => ({ onOpen: () => openProfile(id), title: t('viewProfile') });
  function renderPost(post) {
    const author = profileMap.get(post.author_id);
    const count = counts.find(c => c.post_id === post.id);
    const liked = likes.some(l => l.post_id === post.id);
    const postComments = commentsByPost[post.id] || [];
    const images = postImagePaths(post);
    const editing = editingPost?.id === post.id;
    return <article className="post panel" key={post.id} id={`post-${post.id}`}>
      <div className="post-top"><PersonLink {...linkProps(post.author_id)} className="post-person"><Avatar profile={author}/><span className="post-author"><strong>{display(author)}</strong><small>@{author?.handle || 'member'} - {when(post.created_at)}{post.edited_at && ` · ${t('edited')}`}</small></span></PersonLink>
        {post.author_id === userId && !editing && <div className="post-menu">
          <button className="icon-button" aria-label={t('postOptions')} title={t('postOptions')} aria-haspopup="menu" aria-expanded={menuPost === post.id} disabled={busy !== ''} onClick={e => { e.stopPropagation(); setMenuPost(menuPost === post.id ? '' : post.id); }}><MoreHorizontal size={19}/></button>
          {menuPost === post.id && <div className="menu panel" role="menu">
            <button role="menuitem" onClick={() => startEditPost(post)}><Pencil size={16}/> {t('editPost')}</button>
            <button role="menuitem" className="danger-text" onClick={() => { setMenuPost(''); askConfirm(t('confirmDelete'), t('deletePost'), () => deletePost(post)); }}><Trash2 size={16}/> {t('deletePost')}</button>
          </div>}
        </div>}
      </div>
      {editing ? <form className="post-edit" onSubmit={saveEditPost}>
        <textarea aria-label={t('editPost')} value={editingPost.body} maxLength={MAX_POST} rows={3} onChange={e => setEditingPost(prev => ({ ...prev, body: e.target.value }))}/>
        {(editingPost.keep.length + editingPost.added.length) > 0 && <div className="image-previews">
          {editingPost.keep.map(p => <div className="image-preview" key={p}><img src={publicUrl(POST_IMAGE_BUCKET, p)} alt=""/><button type="button" className="preview-remove" aria-label={t('removeImage')} title={t('removeImage')} onClick={() => setEditingPost(prev => ({ ...prev, keep: prev.keep.filter(k => k !== p) }))}><X size={15}/></button></div>)}
          {editingPost.added.map((item, i) => <div className="image-preview" key={item.preview}><img src={item.preview} alt=""/><button type="button" className="preview-remove" aria-label={t('removeImage')} title={t('removeImage')} onClick={() => setEditingPost(prev => { dropPreviews([item]); return { ...prev, added: prev.added.filter((_, j) => j !== i) }; })}><X size={15}/></button></div>)}
        </div>}
        <div className="composer-footer"><div className="composer-tools">
          <button type="button" className="icon-button" disabled={busy !== '' || editingPost.keep.length + editingPost.added.length >= MAX_IMAGES} onClick={() => editImageInput.current?.click()} aria-label={t('addImage')} title={t('addImage')}><ImagePlus size={20}/></button>
          <input ref={editImageInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e => pickImages(e, editingPost.keep.length + editingPost.added.length, items => setEditingPost(prev => ({ ...prev, added: [...prev.added, ...items] })))}/>
          <small>{editingPost.body.length}/{MAX_POST}</small>
        </div><div className="form-actions-inline"><button type="button" className="secondary" disabled={busy === 'edit'} onClick={cancelEditPost}>{t('cancel')}</button><button className="primary" disabled={busy !== '' || (!editingPost.body.trim() && !editingPost.keep.length && !editingPost.added.length)}>{busy === 'edit' ? t('saving') : t('saveProfile')}</button></div></div>
      </form> : <>
        {post.body && <p className="post-body">{post.body}</p>}
        {images.length > 0 && <div className={`post-images count-${Math.min(images.length, 4)}`}>{images.slice(0, 4).map((p, i) => <button type="button" key={p} className="post-image-cell" onClick={() => setLightbox({ paths: images, index: i })} aria-label={t('openImage', { i: i + 1, n: images.length })}><img src={publicUrl(POST_IMAGE_BUCKET, p)} alt={t('postImageAlt')} loading="lazy"/></button>)}</div>}
      </>}
      <div className="post-actions"><button className={liked ? 'active' : ''} disabled={busy !== ''} aria-label={liked ? t('unlikePost') : t('likePost')} onClick={() => mutate('like', () => liked ? supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', userId) : supabase.from('likes').insert({ post_id: post.id, user_id: userId }))}><Heart size={18} fill={liked ? 'currentColor' : 'none'}/>{count?.like_count ?? 0}</button><button aria-expanded={!!openComments[post.id]} onClick={() => { if (!openComments[post.id]) loadComments(post.id); setOpenComments(prev => ({ ...prev, [post.id]: !prev[post.id] })); }}><MessageCircle size={18}/>{count?.comment_count ?? 0}</button></div>
      {openComments[post.id] && <div className="comments"><h3>{t('comments')}</h3>{loadingComments[post.id] && <p className="muted">{t('loadingComments')}</p>}{!loadingComments[post.id] && postComments.length === 0 && <p className="muted">{t('noComments')}</p>}{postComments.map(c => <div className="comment" key={c.id}><PersonLink {...linkProps(c.author_id)}><Avatar profile={profileMap.get(c.author_id)}/></PersonLink><div><PersonLink {...linkProps(c.author_id)}><strong>{display(profileMap.get(c.author_id))}</strong></PersonLink><small> - {when(c.created_at)}</small><p>{c.body}</p></div></div>)}<form onSubmit={e => addComment(e, post.id)} className="comment-form"><input aria-label={t('writeComment')} maxLength={MAX_COMMENT} placeholder={t('writeComment')} value={commentText[post.id] || ''} onChange={e => setCommentText(prev => ({ ...prev, [post.id]: e.target.value }))}/><button className="primary" disabled={busy !== '' || !commentText[post.id]?.trim()} aria-label={t('sendComment')}><Send size={16}/></button></form></div>}
    </article>;
  }
  function renderProfile() {
    const { data: p, loading: profileLoading } = profileView;
    if (profileView.id !== viewProfileId || (profileLoading && !p)) return <div className="empty panel">{t('loadingProfile')}</div>;
    if (!p) return <div className="empty panel">{t('profileNotFound')}</div>;
    const isMe = p.id === userId;
    const facts = [
      [GraduationCap, t('school'), p.school && t(p.school === 'gaigo' ? 'schoolGaigo' : 'schoolItcollege')],
      [BookOpen, t('course'), p.course],
      [Calendar, t('year'), p.year && t('yearValue', { n: p.year })],
      [User, t('gender'), p.gender && p.gender !== 'private' && t({ male: 'genderMale', female: 'genderFemale', other: 'genderOther' }[p.gender])],
      [Cake, t('birthday'), p.birthday && birthdayText(p.birthday, lang)],
      [MapPin, t('hometown'), p.hometown],
    ].filter(([, , value]) => value);
    return <div className="profile-page">
      {isMe && <input ref={avatarInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={changeAvatar}/>}
      <section className="profile-card panel">
        <div className="profile-cover"/>
        <div className="profile-head">
          <div className={`avatar-wrap ${busy === 'photo' ? 'uploading' : ''}`}>
            <Avatar profile={p} large/>
            {isMe && <button type="button" className="avatar-edit" disabled={busy !== ''} onClick={() => avatarInput.current?.click()} aria-label={p.avatar_path ? t('changePhoto') : t('addPhoto')} title={p.avatar_path ? t('changePhoto') : t('addPhoto')}><Camera size={16}/></button>}
          </div>
          <div className="profile-actions">
            {isMe
              ? !editing && <button className="secondary" onClick={startEdit}><Pencil size={16}/> {t('editProfile')}</button>
              : <><button className={followingIds.has(p.id) ? 'secondary' : 'primary'} disabled={busy !== ''} onClick={() => toggleFollow(p.id)}>{followingIds.has(p.id) ? <UserCheck size={16}/> : <UserPlus size={16}/>} {followingIds.has(p.id) ? t('following') : t('follow')}</button><button className="secondary" onClick={() => openConversation(p)}><Mail size={16}/> {t('message')}</button></>}
          </div>
        </div>
        <h2 className="profile-name">{display(p)}</h2>
        <p className="profile-handle">@{p.handle}{!isMe && followerIds.has(p.id) && <span className="tag">{t('followsYou')}</span>}</p>
        {p.bio && <p className="profile-bio">{p.bio}</p>}
        {facts.length > 0 && <ul className="profile-facts">{facts.map(([Icon, label, value]) => <li key={label}><Icon size={16} aria-hidden="true"/><span className="fact-label">{label}</span><span>{value}</span></li>)}</ul>}
        <p className="profile-joined"><Calendar size={14} aria-hidden="true"/> {t('joined')} {new Date(p.created_at).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'long' })}</p>
        <div className="profile-stats"><span><strong>{profileView.posts.length}</strong> {t('postsCount')}</span><span><strong>{profileView.followers}</strong> {t('followers')}</span><span><strong>{profileView.following}</strong> {t('followingCount')}</span></div>
      </section>
      {isMe && editing && <form className="profile-form panel" onSubmit={saveProfile}>
        <h2>{t('editProfile')}</h2>
        <div className="photo-row"><Avatar profile={p}/><button type="button" className="secondary" disabled={busy !== ''} onClick={() => avatarInput.current?.click()}><Camera size={16}/> {busy === 'photo' ? t('uploading') : p.avatar_path ? t('changePhoto') : t('addPhoto')}</button>{p.avatar_path && <button type="button" className="text-button danger-text" disabled={busy !== ''} onClick={() => askConfirm(t('confirmRemovePhoto'), t('removePhoto'), removeAvatar)}>{t('removePhoto')}</button>}</div>
        <div className="form-grid">
          <label>{t('displayName')}<input required maxLength={60} value={form.display_name} onChange={setField('display_name')}/></label>
          <label>{t('username')}<input required minLength={3} maxLength={34} value={form.handle} onChange={e => setForm(prev => ({ ...prev, handle: e.target.value.toLowerCase() }))}/></label>
          <label>{t('school')}<select value={form.school} onChange={setField('school')}><option value="">{t('chooseOne')}</option><option value="gaigo">{t('schoolGaigo')}</option><option value="itcollege">{t('schoolItcollege')}</option></select></label>
          <label>{t('course')}<input maxLength={80} value={form.course} onChange={setField('course')} placeholder={t('coursePlaceholder')}/></label>
          <label>{t('year')}<select value={form.year} onChange={setField('year')}><option value="">{t('chooseOne')}</option>{[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{t('yearValue', { n })}</option>)}</select></label>
          <label>{t('gender')}<select value={form.gender} onChange={setField('gender')}><option value="">{t('chooseOne')}</option><option value="male">{t('genderMale')}</option><option value="female">{t('genderFemale')}</option><option value="other">{t('genderOther')}</option><option value="private">{t('genderPrivate')}</option></select></label>
          <label>{t('birthday')}<input type="date" min="1900-01-01" max={new Date().toISOString().slice(0, 10)} value={form.birthday} onChange={setField('birthday')}/><small>{t('birthdayNote')}</small></label>
          <label>{t('hometown')}<input maxLength={80} value={form.hometown} onChange={setField('hometown')} placeholder={t('hometownPlaceholder')}/></label>
          <label className="full">{t('aboutMe')}<textarea rows={3} maxLength={300} value={form.bio} onChange={setField('bio')} placeholder={t('bioPlaceholder')}/><small>{form.bio.length}/300</small></label>
        </div>
        <div className="form-actions"><button type="button" className="secondary" onClick={() => setEditing(false)}>{t('cancel')}</button><button className="primary" disabled={busy !== ''}>{busy === 'profile' ? t('saving') : t('saveProfile')}</button></div>
      </form>}
      <div className="section-heading"><h2>{t('postsCount')}</h2></div>
      {profileView.posts.length === 0 && <div className="empty panel">{t('noProfilePosts')}</div>}
      {profileView.posts.map(renderPost)}
    </div>;
  }
  const navTitles = { feed: t('navFeed'), notifications: t('navNotifications'), people: t('navPeople'), messages: t('navMessages'), profile: t('navProfile') };
  const viewingOther = tab === 'profile' && viewProfileId && viewProfileId !== userId;
  if (!supabase) return <div className="auth-wrap"><div className="auth-card"><div className="brand">CampConnect</div><h1>{t('connectDbTitle')}</h1><p className="muted">{t('connectDbBody')}</p></div></div>;
  if (checking) return <div className="center-state">{t('loadingApp')}</div>;
  if (!session) return <><Auth notify={setNotice} t={t} lang={lang} onChangeLang={changeLang} theme={theme} onToggleTheme={toggleTheme}/>{notice && <div className="toast" role="status">{notice}</div>}</>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">CampConnect</div>
      <nav aria-label={t('mainNav')}>{[['feed', Home], ['notifications', Bell], ['people', Users], ['messages', Mail], ['profile', User]].map(([id, Icon]) => {
        // "Profile" in the menu means my own profile; viewing someone else's highlights nothing.
        const current = id === 'profile' ? tab === 'profile' && viewProfileId === userId : tab === id;
        return <button key={id} className={`nav-link ${current ? 'selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => (id === 'profile' ? openProfile(userId) : setTab(id))}><Icon size={20}/>{navTitles[id]}{badges[id] > 0 && <span className="badge" aria-label={t('newCount', { n: badges[id] })}>{badgeText(badges[id])}</span>}</button>;
      })}</nav>
      <div className="sidebar-bottom"><div className="prefs"><LangToggle t={t} lang={lang} onChange={changeLang}/><ThemeToggle t={t} theme={theme} onToggle={toggleTheme}/></div><div className="account-row"><button type="button" className="account" onClick={() => openProfile(userId)} title={t('viewProfile')}><Avatar profile={mine}/><div><strong>{display(mine)}</strong><small>@{mine?.handle || '...'}</small></div></button><button className="icon-button" aria-label={t('signOut')} title={t('signOut')} onClick={async () => { const { error: err } = await supabase.auth.signOut(); if (err) setError(err.message); }}><LogOut size={18}/></button></div></div>
    </aside>
    <main className="main-panel">
      <header className="main-header"><div><p className="eyebrow">{t('yourCommunity')}</p><h1>{viewingOther ? display(profileMap.get(viewProfileId) || profileView.data) : navTitles[tab]}</h1></div><button className="icon-button" title={t('refresh')} aria-label={t('refresh')} onClick={() => { loadCommunity(true); loadNotifications(); if (tab === 'messages') loadMessages(); if (tab === 'profile') loadProfile(viewProfileId); }}><RefreshCw size={19}/></button></header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label={t('dismissError')}>x</button></div>}
      {tab === 'feed' && <>
        <form className="composer panel" onSubmit={publish}><div className="composer-head"><Avatar profile={mine}/><label htmlFor="post-body">{t('shareThought')}</label></div><textarea id="post-body" value={postText} maxLength={MAX_POST} onChange={e => setPostText(e.target.value)} placeholder={t('whatsHappening')} rows={3}/>{postImages.length > 0 && <div className="image-previews">{postImages.map((item, i) => <div className="image-preview" key={item.preview}><img src={item.preview} alt=""/><button type="button" className="preview-remove" onClick={() => removePostImage(i)} disabled={busy !== ''} aria-label={t('removeImage')} title={t('removeImage')}><X size={15}/></button></div>)}</div>}<div className="composer-footer"><div className="composer-tools"><button type="button" className="icon-button" disabled={busy !== '' || postImages.length >= MAX_IMAGES} onClick={() => postImageInput.current?.click()} aria-label={t('addImage')} title={t('addImage')}><ImagePlus size={20}/></button><input ref={postImageInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e => pickImages(e, postImages.length, items => setPostImages(prev => [...prev, ...items]))}/><small>{postText.length}/{MAX_POST}{postImages.length > 0 && ` · ${t('imageCount', { n: postImages.length, max: MAX_IMAGES })}`}</small></div><button className="primary" disabled={busy !== '' || (!postText.trim() && !postImages.length)}><Send size={16}/> {busy === 'post' ? t('uploading') : t('post')}</button></div></form>
        <div className="section-heading"><h2>{t('latestPosts')}</h2>{loading && <span>{t('loading')}</span>}</div>
        {!loading && posts.length === 0 && <div className="empty panel">{t('noPosts')}</div>}
        {posts.map(renderPost)}
      </>}
      {tab === 'notifications' && <div className="notif-list">
        {notifications.length === 0 && <div className="empty panel">{t('noNotifications')}</div>}
        {notifications.map(n => {
          const actor = profileMap.get(n.actor);
          const KindIcon = { like: Heart, comment: MessageCircle, post: Sparkles, follow: UserPlus }[n.kind];
          return <button key={n.key} className={`notif panel ${n.unread || freshNotifs.includes(n.key) ? 'unread' : ''}`} onClick={() => openNotification(n)}>
            <span className="notif-avatar"><Avatar profile={actor}/><span className={`notif-kind kind-${n.kind}`}><KindIcon size={11}/></span></span>
            <span className="notif-body">
              <span><strong>{display(actor)}</strong>{t({ like: 'notifLike', comment: 'notifComment', post: 'notifPost', follow: 'notifFollow' }[n.kind])}{n.text && <>{t('quoteSep')}<q>{snip(n.text)}</q></>}</span>
              {n.at && <small>{when(n.at)}</small>}
            </span>
          </button>;
        })}
      </div>}
      {tab === 'people' && <div className="people-section"><label className="search-box"><Search size={19}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('searchPeople')} aria-label={t('searchPeople')}/></label><div className="section-heading"><h2>{t('members')}</h2><span>{searching ? t('searching') : filtered.length}</span></div>{filtered.length === 0 && <div className="empty panel">{query ? t('noMatch') : t('noMembers')}</div>}{filtered.map(p => <div className="member panel" key={p.id}><PersonLink {...linkProps(p.id)} className="member-person"><Avatar profile={p}/><span className="member-info"><strong>{display(p)}</strong><small>@{p.handle}</small>{newFollowerIds.includes(p.id) ? <span className="tag new">{t('newFollower')}</span> : followerIds.has(p.id) && <span className="tag">{t('followsYou')}</span>}</span></PersonLink><div className="member-actions"><button className="secondary" disabled={busy !== ''} onClick={() => toggleFollow(p.id)}>{followingIds.has(p.id) ? <UserCheck size={16}/> : <UserPlus size={16}/>} {followingIds.has(p.id) ? t('following') : t('follow')}</button><button className="secondary" onClick={() => openConversation(p)}><Mail size={16}/> {t('message')}</button></div></div>)}</div>}
      {tab === 'messages' && <div className="messages-layout"><div className="contact-list panel"><h2>{t('newConversation')}</h2><p className="muted">{t('chooseMember')}</p>{contacts.map(p => <button key={p.id} className={`contact ${recipient === p.id ? 'selected' : ''}`} onClick={() => { messageRequest.current += 1; setMessages([]); setRecipient(p.id); }}><Avatar profile={p}/><span><strong>{display(p)}</strong><small>@{p.handle}</small></span>{unreadBySender[p.id] > 0 && <span className="badge" aria-label={t('unreadCount', { n: unreadBySender[p.id] })}>{badgeText(unreadBySender[p.id])}</span>}</button>)}{others.length === 0 && <p className="muted">{t('noMembers')}</p>}</div><section className="conversation panel" aria-label={t('conversation')}>{recipient ? <><div className="conversation-header"><PersonLink {...linkProps(recipient)} className="post-person"><Avatar profile={profileMap.get(recipient)}/><strong>{display(profileMap.get(recipient))}</strong></PersonLink><button className="icon-button" aria-label={t('refreshMessages')} onClick={loadMessages}><RefreshCw size={17}/></button></div><div className="message-list" aria-live="polite">{messages.length === 0 && <div className="empty-message">{t('noMessages')}</div>}{messages.map(m => <div key={m.id} className={`message ${m.sender_id === userId ? 'mine' : ''}`}><p>{m.body}</p><small>{when(m.created_at)}</small></div>)}</div><form className="message-form" onSubmit={sendMessage}><input aria-label={t('writeMessage')} placeholder={t('writeMessage')} maxLength={MAX_MESSAGE} value={messageText} onChange={e => setMessageText(e.target.value)}/><button className="primary" disabled={busy !== '' || !messageText.trim()} aria-label={t('sendMessage')}><Send size={17}/></button></form></> : <div className="empty-message"><Mail size={28}/><p>{t('selectSomeone')}</p></div>}</section></div>}
      {tab === 'profile' && renderProfile()}
    </main>
    {flash && <div className="toast" role="status">{flash}</div>}
    {confirmBox && <ConfirmDialog message={confirmBox.message} confirmLabel={confirmBox.confirmLabel} cancelLabel={t('cancel')} onCancel={() => setConfirmBox(null)} onConfirm={() => { const run = confirmBox.onConfirm; setConfirmBox(null); run(); }}/>}
    {lightbox && <Lightbox t={t} urls={lightbox.paths.map(p => publicUrl(POST_IMAGE_BUCKET, p))} index={lightbox.index} onIndex={index => setLightbox(prev => ({ ...prev, index }))} onClose={() => setLightbox(null)}/>}
  </div>;
}






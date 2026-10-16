import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, MessageCircle, Send, Trash2, UserPlus, UserCheck, Home, Users, Mail, LogOut, RefreshCw, Search, Sparkles, Bell } from 'lucide-react';
import { supabase } from './lib/supabase.js';
import { translate, initialLang, saveLang } from './i18n.js';

const MAX_POST = 500;
const MAX_COMMENT = 300;
const MAX_MESSAGE = 1000;
// Only school accounts may join. The database enforces this too (supabase/migrations/0002_restrict_email_domain.sql).
const SCHOOL_DOMAIN = 'osfl.ac.jp';
const isSchoolEmail = value => value.trim().toLowerCase().endsWith(`@${SCHOOL_DOMAIN}`);
const stamp = (value, lang) => new Date(value).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
const snip = (text, max = 70) => (text.length > max ? `${text.slice(0, max).trimEnd()}...` : text);
const display = profile => profile?.display_name || profile?.handle || 'Member';
function Avatar({ profile }) { return <span className="avatar" aria-hidden="true">{display(profile).slice(0, 1).toUpperCase()}</span>; }
function LangToggle({ t, onToggle }) { return <button type="button" className="lang-toggle" onClick={onToggle} aria-label={t('switchLabel')} title={t('switchLabel')}>{t('switchTo')}</button>; }

function Auth({ notify, t, onToggleLang }) {
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
    <div className="auth-top"><div className="brand">CampConnect</div><LangToggle t={t} onToggle={onToggleLang}/></div>
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
  const toggleLang = () => setLang(prev => { const next = prev === 'en' ? 'ja' : 'en'; saveLang(next); return next; });
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
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
  const loadCommunity = useCallback(async (spin = false) => {
    if (!userId) return;
    if (spin) setLoading(true);
    try {
      const [postResult, recentProfiles, followResult] = await Promise.all([
        supabase.from('posts').select('id,author_id,body,created_at').order('created_at', { ascending: false }).limit(100),
        supabase.from('profiles').select('id,handle,display_name,created_at').order('created_at', { ascending: false }).limit(50),
        supabase.from('follows').select('follower_id,following_id').eq('follower_id', userId),
      ]);
      const firstError = [postResult, recentProfiles, followResult].find(r => r.error);
      if (firstError) throw firstError.error;
      const postRows = postResult.data || [];
      const ids = postRows.map(p => p.id);
      const authorIds = [...new Set([...postRows.map(p => p.author_id), userId])];
      const [authorResult, countResult, likeResult] = await Promise.all([
        supabase.from('profiles').select('id,handle,display_name,created_at').in('id', authorIds),
        ids.length ? supabase.from('post_counts').select('post_id,like_count,comment_count').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('likes').select('post_id,user_id').eq('user_id', userId).in('post_id', ids) : Promise.resolve({ data: [], error: null }),
      ]);
      const secondError = [authorResult, countResult, likeResult].find(r => r.error);
      if (secondError) throw secondError.error;
      const byId = new Map([...(recentProfiles.data || []), ...(authorResult.data || [])].map(p => [p.id, p]));
      setProfiles([...byId.values()]); setPosts(postRows);
      setCounts(countResult.data || []); setLikes(likeResult.data || []);
      setFollows(followResult.data || []); setError('');
    } catch (err) { setError(err.message || translate(langRef.current, 'errLoadCommunity')); }
    finally { if (spin) setLoading(false); }
  }, [userId]);
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
          .select('id,handle,display_name,created_at').in('id', authorIds);
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
  const loadNotifications = useCallback(async () => {
    if (!userId) return;
    const [followerResult, inboxResult, likeResult, commentResult, postResult] = await Promise.all([
      supabase.from('follows').select('follower_id').eq('following_id', userId),
      supabase.from('direct_messages').select('sender_id,created_at').eq('recipient_id', userId).order('created_at', { ascending: false }).limit(500),
      // Likes and comments on my posts (the !inner join keeps only rows whose post I wrote).
      supabase.from('likes').select('post_id,user_id,posts!inner(author_id,body)').eq('posts.author_id', userId).neq('user_id', userId).limit(500),
      supabase.from('comments').select('id,post_id,author_id,body,created_at,posts!inner(author_id)').eq('posts.author_id', userId).neq('author_id', userId).order('created_at', { ascending: false }).limit(100),
      supabase.from('posts').select('id,author_id,body,created_at').neq('author_id', userId).order('created_at', { ascending: false }).limit(50),
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
      const { data, error: err } = await supabase.from('profiles').select('id,handle,display_name,created_at').in('id', peopleIds);
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
    if (!userId || tab !== 'people' || !query.trim()) { setSearchResults([]); setSearching(false); return undefined; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const term = query.trim().replace(/[^a-zA-Z0-9_ ]/g, '');
      if (!term) { if (!cancelled) { setSearchResults([]); setSearching(false); } return; }
      const { data, error: searchError } = await supabase.from('profiles')
        .select('id,handle,display_name,created_at')
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
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  function publish(e) {
    e.preventDefault(); const body = postText.trim();
    if (!body || body.length > MAX_POST) return;
    mutate('post', () => supabase.from('posts').insert({ author_id: userId, body }), () => setPostText(''));
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
  const navTitles = { feed: t('navFeed'), notifications: t('navNotifications'), people: t('navPeople'), messages: t('navMessages') };
  if (!supabase) return <div className="auth-wrap"><div className="auth-card"><div className="brand">CampConnect</div><h1>{t('connectDbTitle')}</h1><p className="muted">{t('connectDbBody')}</p></div></div>;
  if (checking) return <div className="center-state">{t('loadingApp')}</div>;
  if (!session) return <><Auth notify={setNotice} t={t} onToggleLang={toggleLang}/>{notice && <div className="toast" role="status">{notice}</div>}</>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">CampConnect</div>
      <nav aria-label={t('mainNav')}>{[['feed', Home], ['notifications', Bell], ['people', Users], ['messages', Mail]].map(([id, Icon]) => <button key={id} className={`nav-link ${tab === id ? 'selected' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={20}/>{navTitles[id]}{badges[id] > 0 && <span className="badge" aria-label={t('newCount', { n: badges[id] })}>{badgeText(badges[id])}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="account"><Avatar profile={mine}/><div><strong>{display(mine)}</strong><small>@{mine?.handle || '...'}</small></div></div><LangToggle t={t} onToggle={toggleLang}/><button className="icon-button" aria-label={t('signOut')} title={t('signOut')} onClick={async () => { const { error: err } = await supabase.auth.signOut(); if (err) setError(err.message); }}><LogOut size={18}/></button></div>
    </aside>
    <main className="main-panel">
      <header className="main-header"><div><p className="eyebrow">{t('yourCommunity')}</p><h1>{navTitles[tab]}</h1></div><button className="icon-button" title={t('refresh')} aria-label={t('refresh')} onClick={() => { loadCommunity(true); loadNotifications(); if (tab === 'messages') loadMessages(); }}><RefreshCw size={19}/></button></header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label={t('dismissError')}>x</button></div>}
      {tab === 'feed' && <>
        <form className="composer panel" onSubmit={publish}><div className="composer-head"><Avatar profile={mine}/><label htmlFor="post-body">{t('shareThought')}</label></div><textarea id="post-body" value={postText} maxLength={MAX_POST} onChange={e => setPostText(e.target.value)} placeholder={t('whatsHappening')} rows={3}/><div className="composer-footer"><small>{postText.length}/{MAX_POST}</small><button className="primary" disabled={busy !== '' || !postText.trim()}><Send size={16}/> {t('post')}</button></div></form>
        <div className="section-heading"><h2>{t('latestPosts')}</h2>{loading && <span>{t('loading')}</span>}</div>
        {!loading && posts.length === 0 && <div className="empty panel">{t('noPosts')}</div>}
        {posts.map(post => {
          const author = profileMap.get(post.author_id);
          const count = counts.find(c => c.post_id === post.id);
          const liked = likes.some(l => l.post_id === post.id);
          const postComments = commentsByPost[post.id] || [];
          return <article className="post panel" key={post.id} id={`post-${post.id}`}>
            <div className="post-top"><Avatar profile={author}/><div className="post-author"><strong>{display(author)}</strong><small>@{author?.handle || 'member'} - {when(post.created_at)}</small></div>{post.author_id === userId && <button className="icon-button danger" title={t('deletePost')} aria-label={t('deletePost')} disabled={busy !== ''} onClick={() => { if (window.confirm(t('confirmDelete'))) mutate('delete', () => supabase.from('posts').delete().eq('id', post.id)); }}><Trash2 size={17}/></button>}</div>
            <p className="post-body">{post.body}</p>
            <div className="post-actions"><button className={liked ? 'active' : ''} disabled={busy !== ''} aria-label={liked ? t('unlikePost') : t('likePost')} onClick={() => mutate('like', () => liked ? supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', userId) : supabase.from('likes').insert({ post_id: post.id, user_id: userId }))}><Heart size={18} fill={liked ? 'currentColor' : 'none'}/>{count?.like_count ?? 0}</button><button aria-expanded={!!openComments[post.id]} onClick={() => { if (!openComments[post.id]) loadComments(post.id); setOpenComments(prev => ({ ...prev, [post.id]: !prev[post.id] })); }}><MessageCircle size={18}/>{count?.comment_count ?? 0}</button></div>
            {openComments[post.id] && <div className="comments"><h3>{t('comments')}</h3>{loadingComments[post.id] && <p className="muted">{t('loadingComments')}</p>}{!loadingComments[post.id] && postComments.length === 0 && <p className="muted">{t('noComments')}</p>}{postComments.map(c => <div className="comment" key={c.id}><Avatar profile={profileMap.get(c.author_id)}/><div><strong>{display(profileMap.get(c.author_id))}</strong><small> - {when(c.created_at)}</small><p>{c.body}</p></div></div>)}<form onSubmit={e => addComment(e, post.id)} className="comment-form"><input aria-label={t('writeComment')} maxLength={MAX_COMMENT} placeholder={t('writeComment')} value={commentText[post.id] || ''} onChange={e => setCommentText(prev => ({ ...prev, [post.id]: e.target.value }))}/><button className="primary" disabled={busy !== '' || !commentText[post.id]?.trim()} aria-label={t('sendComment')}><Send size={16}/></button></form></div>}
          </article>;
        })}
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
      {tab === 'people' && <div className="people-section"><label className="search-box"><Search size={19}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('searchPeople')} aria-label={t('searchPeople')}/></label><div className="section-heading"><h2>{t('members')}</h2><span>{searching ? t('searching') : filtered.length}</span></div>{filtered.length === 0 && <div className="empty panel">{query ? t('noMatch') : t('noMembers')}</div>}{filtered.map(p => <div className="member panel" key={p.id}><Avatar profile={p}/><div className="member-info"><strong>{display(p)}</strong><small>@{p.handle}</small>{newFollowerIds.includes(p.id) ? <span className="tag new">{t('newFollower')}</span> : followerIds.has(p.id) && <span className="tag">{t('followsYou')}</span>}</div><div className="member-actions"><button className="secondary" disabled={busy !== ''} onClick={() => mutate('follow', () => followingIds.has(p.id) ? supabase.from('follows').delete().eq('follower_id', userId).eq('following_id', p.id) : supabase.from('follows').insert({ follower_id: userId, following_id: p.id }))}>{followingIds.has(p.id) ? <UserCheck size={16}/> : <UserPlus size={16}/>} {followingIds.has(p.id) ? t('following') : t('follow')}</button><button className="secondary" onClick={() => { messageRequest.current += 1; setMessages([]); setSelectedProfile(p); setRecipient(p.id); setTab('messages'); }}><Mail size={16}/> {t('message')}</button></div></div>)}</div>}
      {tab === 'messages' && <div className="messages-layout"><div className="contact-list panel"><h2>{t('newConversation')}</h2><p className="muted">{t('chooseMember')}</p>{contacts.map(p => <button key={p.id} className={`contact ${recipient === p.id ? 'selected' : ''}`} onClick={() => { messageRequest.current += 1; setMessages([]); setRecipient(p.id); }}><Avatar profile={p}/><span><strong>{display(p)}</strong><small>@{p.handle}</small></span>{unreadBySender[p.id] > 0 && <span className="badge" aria-label={t('unreadCount', { n: unreadBySender[p.id] })}>{badgeText(unreadBySender[p.id])}</span>}</button>)}{others.length === 0 && <p className="muted">{t('noMembers')}</p>}</div><section className="conversation panel" aria-label={t('conversation')}>{recipient ? <><div className="conversation-header"><Avatar profile={profileMap.get(recipient)}/><strong>{display(profileMap.get(recipient))}</strong><button className="icon-button" aria-label={t('refreshMessages')} onClick={loadMessages}><RefreshCw size={17}/></button></div><div className="message-list" aria-live="polite">{messages.length === 0 && <div className="empty-message">{t('noMessages')}</div>}{messages.map(m => <div key={m.id} className={`message ${m.sender_id === userId ? 'mine' : ''}`}><p>{m.body}</p><small>{when(m.created_at)}</small></div>)}</div><form className="message-form" onSubmit={sendMessage}><input aria-label={t('writeMessage')} placeholder={t('writeMessage')} maxLength={MAX_MESSAGE} value={messageText} onChange={e => setMessageText(e.target.value)}/><button className="primary" disabled={busy !== '' || !messageText.trim()} aria-label={t('sendMessage')}><Send size={17}/></button></form></> : <div className="empty-message"><Mail size={28}/><p>{t('selectSomeone')}</p></div>}</section></div>}
    </main>
  </div>;
}






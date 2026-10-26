import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, MessageCircle, Send, Trash2, UserPlus, UserCheck, Home, Users, Mail, LogOut, RefreshCw, Search, Sparkles, Bell, Sun, Moon, User, Pencil, GraduationCap, BookOpen, Cake, MapPin, Calendar, Camera, ImagePlus, X, MoreHorizontal, Info, Plus, Flag, ChevronLeft, ChevronRight, Share2, Link, ArrowLeft, Check, CheckCheck, Shield, UsersRound, Bookmark, FolderInput, Folder } from 'lucide-react';
import { supabase } from './lib/supabase.js';
import { loadChatIdentity, registerChatIdentity, recoverChatIdentity, resetChatIdentity, acknowledgeRecoveryCode, loadEncryptedConversation, sendEncryptedMessage } from './lib/chatApi.js';
import { clearLocalChatIdentity } from './lib/e2ee.js';
import { buildAudienceEditPayload } from './lib/postAudience.js';
import { orderVisibleSavedPosts } from './lib/savedPosts.js';
import loginLogo from './login-logo.png';
import gaigoLogo from './gaigo-logo.png';
import itcollegeLogo from './itcollege-logo.png';
import { AVATAR_BUCKET, POST_IMAGE_BUCKET, isImageFile, publicUrl, shrinkImage, uploadImage, removeImages, postImagePaths } from './images.js';
import { translate, initialLang, saveLang } from './i18n.js';
import { initialTheme, saveTheme } from './theme.js';
import { handleFromEmail } from './username.js';
import { unlockAudio, playSound } from './sounds.js';

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
  return <span className={className} aria-hidden="true"><User/></span>;
}
// Birthdays are stored as YYYY-MM-DD; show only month and day, and avoid timezone shifts.
const birthdayText = (value, lang) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
};
const mergeRows = (prev, rows, key) => [...new Map([...prev, ...rows].map(r => [r[key], r])).values()];
async function searchAudienceProfiles(term, userId) {
  const [handles, names] = await Promise.all([
    supabase.from('profiles').select('id,handle,display_name,avatar_path').ilike('handle', `%${term}%`).limit(15),
    supabase.from('profiles').select('id,handle,display_name,avatar_path').ilike('display_name', `%${term}%`).limit(15),
  ]);
  if (handles.error || names.error) throw (handles.error || names.error);
  return [...new Map([...(handles.data || []), ...(names.data || [])]
    .filter(profile => profile.id !== userId)
    .map(profile => [profile.id, profile])).values()].slice(0, 20);
}
const EMPTY_FORM = { display_name: '', handle: '', school: '', course: '', year: '', gender: '', birthday: '', hometown: '', bio: '' };
// A person's avatar and/or name, clickable to open their profile.
function PersonLink({ onOpen, title, className = '', children }) {
  return <button type="button" className={`person-link ${className}`} onClick={onOpen} title={title}>{children}</button>;
}
function ReportDialog({ t, busy, onCancel, onSubmit }) {
  const [reason, setReason] = useState('spam');
  const [note, setNote] = useState('');
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return <div className="modal-backdrop" onClick={onCancel}>
    <form className="modal panel report-form" role="dialog" aria-modal="true" aria-label={t('reportTitle')} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); onSubmit(reason, note); }}>
      <h3>{t('reportTitle')}</h3>
      <p className="muted">{t('reportPrivacy')}</p>
      <label>{t('reportReason')}<select value={reason} onChange={e => setReason(e.target.value)}>{['spam', 'harassment', 'inappropriate', 'other'].map(r => <option key={r} value={r}>{t(`reason_${r}`)}</option>)}</select></label>
      <label>{t('reportNote')}<textarea rows={3} maxLength={300} value={note} onChange={e => setNote(e.target.value)}/></label>
      <div className="form-actions-inline"><button type="button" className="secondary" onClick={onCancel}>{t('cancel')}</button><button className="danger-button" disabled={busy}>{t('sendReport')}</button></div>
    </form>
  </div>;
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
function Lightbox({ t, urls, index, onIndex, onClose, post, canReport, likeCount, commentCount, liked, saved, busy, onLike, onComment, onSave, onShare, onCopyLink, onReport }) {
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
    {post && <div className="lightbox-post-actions" role="toolbar" aria-label={t('postActions')} onClick={e => e.stopPropagation()}>
      <button type="button" className={liked ? 'active' : ''} disabled={busy} aria-label={liked ? t('unlikePost') : t('likePost')} onClick={onLike}><Heart size={19} fill={liked ? 'currentColor' : 'none'}/><span>{likeCount}</span></button>
      <button type="button" aria-label={t('comments')} onClick={onComment}><MessageCircle size={19}/><span>{commentCount}</span></button>
      <button type="button" className={saved ? 'active' : ''} disabled={busy} aria-label={saved ? t('unsavePost') : t('savePost')} onClick={onSave}><Bookmark size={19} fill={saved ? 'currentColor' : 'none'}/></button>
      <button type="button" onClick={onShare}><Share2 size={19}/><span>{t('share')}</span></button>
      <button type="button" onClick={onCopyLink}><Link size={18}/><span>{t('copyLink')}</span></button>
      {canReport && <button type="button" aria-label={t('reportPost')} onClick={onReport}><Flag size={18}/><span>{t('reportPost')}</span></button>}
    </div>}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The username is the school email ID; the database sets it, this is just the preview.
  const h = handleFromEmail(email);
  async function submit(e) {
    e.preventDefault(); setError('');
    if (!isSchoolEmail(email)) { setError(t('errSchoolEmail', { example: `w25009@${SCHOOL_DOMAIN}` })); return; }
    if (signup && !name.trim()) { setError(t('errSignupFields')); return; }
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
    <div className="auth-top"><div className="auth-logos"><img className="auth-side-logo" src={gaigoLogo} alt="Gaigo"/><img className="auth-logo" src={loginLogo} alt="CampConnect"/><img className="auth-side-logo" src={itcollegeLogo} alt="IT College"/></div><div className="prefs"><LangToggle t={t} lang={lang} onChange={onChangeLang}/><ThemeToggle t={t} theme={theme} onToggle={onToggleTheme}/></div></div>
    <h1 lang={lang}>{signup ? t('createAccountTitle') : t('tagline')}</h1>
    {signup && <p className="muted">{t('signupSubtitle')}</p>}
    <form className="stack-form" onSubmit={submit}>
      {signup && <label>{t('displayName')}<input required maxLength={60} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label>}
      <label>{t('schoolEmail')}<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={`w25000@${SCHOOL_DOMAIN}`} /></label>
      {signup && <p className="username-preview">{isSchoolEmail(email) ? t('usernamePreview', { handle: h }) : t('usernameHint')}</p>}
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
  const [savedPostIds, setSavedPostIds] = useState([]);
  const [savedPostCollections, setSavedPostCollections] = useState({});
  const [savedCollections, setSavedCollections] = useState([]);
  const [savedCollectionFilter, setSavedCollectionFilter] = useState('all');
  const [newSavedCollection, setNewSavedCollection] = useState('');
  const [savedIdsLoading, setSavedIdsLoading] = useState(true);
  const [savedRevision, setSavedRevision] = useState(0);
  const [savedPosts, setSavedPosts] = useState([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const savedPostsRequest = useRef(0);
  const [groups, setGroups] = useState([]);
  const [groupPreviews, setGroupPreviews] = useState({});
  const [groupHistory, setGroupHistory] = useState({ id: '', posts: [], authors: [], hasMore: false, loading: false });
  const [communityRevision, setCommunityRevision] = useState(0);
  const groupHistoryRequest = useRef(0);
  const historyScroll = useRef(null);
  const [groupMembers, setGroupMembers] = useState([]);
  const [activeGroup, setActiveGroup] = useState('');
  const [groupEditName, setGroupEditName] = useState(null);
  const [boardText, setBoardText] = useState('');
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupView, setGroupView] = useState('list'); // phones show the list or one thread
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const threadRef = useRef(null);
  const [groupName, setGroupName] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberMatches, setMemberMatches] = useState([]);
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
  const [postAudience, setPostAudience] = useState('school');
  const [postGroup, setPostGroup] = useState('');
  const [chosenStudents, setChosenStudents] = useState([]);
  const [audienceQuery, setAudienceQuery] = useState('');
  const [audienceMatches, setAudienceMatches] = useState([]);
  const [editAudienceQuery, setEditAudienceQuery] = useState('');
  const [editAudienceMatches, setEditAudienceMatches] = useState([]);
  const [postImages, setPostImages] = useState([]); // [{ file, preview }] picked in the composer
  const postImageInput = useRef(null);
  const editImageInput = useRef(null);
  const [menuPost, setMenuPost] = useState(''); // post whose ⋯ menu is open
  const [editingPost, setEditingPost] = useState(null); // { id, audience, groupId, recipients, body, keep, added, original }
  const [reportTarget, setReportTarget] = useState(null); // { type, id }
  const [confirmBox, setConfirmBox] = useState(null); // { message, confirmLabel, onConfirm }
  const [lightbox, setLightbox] = useState(null); // { paths, index }
  const [focusPost, setFocusPost] = useState({ id: '', post: null, loading: false }); // single-post page
  const [shareTarget, setShareTarget] = useState(null); // post being sent to someone in a message
  const [shareQuery, setShareQuery] = useState('');
  // Our own confirm dialog: the browser's confirm() is blocked in some browsers.
  const askConfirm = (message, confirmLabel, onConfirm) => setConfirmBox({ message, confirmLabel, onConfirm });
  useEffect(() => {
    if (!menuPost) return undefined;
    const close = () => setMenuPost('');
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuPost]);
  const avatarInput = useRef(null);
  const groupAvatarInput = useRef(null);
  const [messageText, setMessageText] = useState('');
  const [chatIdentity, setChatIdentity] = useState(null);
  const [chatKeyLoading, setChatKeyLoading] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recipientKey, setRecipientKey] = useState(null);
  const [recipientFingerprint, setRecipientFingerprint] = useState('');
  const [verifiedRecipientFingerprint, setVerifiedRecipientFingerprint] = useState('');
  const [blockedIds, setBlockedIds] = useState([]);
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
  const communityRequest = useRef(0);
  const communityUser = useRef(userId);
  communityUser.current = userId;
  const recipientRef = useRef('');
  const chatIdentityRef = useRef(null);
  useEffect(() => { chatIdentityRef.current = chatIdentity; }, [chatIdentity]);
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
    const request = ++communityRequest.current;
    if (spin) setLoading(true);
    try {
      const [postResult, recentProfiles, followResult, groupResult, membershipResult] = await Promise.all([
        supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(100),
        supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('follows').select('follower_id,following_id').eq('follower_id', userId),
        supabase.from('student_groups').select('id,name,owner_id,created_at,avatar_path').order('created_at', { ascending: false }),
        supabase.from('student_group_members').select('group_id,user_id,joined_at'),
      ]);
      const firstError = [postResult, recentProfiles, followResult, groupResult, membershipResult].find(r => r.error);
      if (firstError) throw firstError.error;
      const previewResults = await Promise.all((groupResult.data || []).map(group =>
        supabase.from('posts').select('id,group_id,author_id,body,created_at').eq('group_id', group.id).eq('audience', 'group')
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1)));
      const previewError = previewResults.find(result => result.error);
      if (previewError) throw previewError.error;
      const previewRows = previewResults.flatMap(result => result.data || []);
      const postRows = postResult.data || [];
      const ids = postRows.map(p => p.id);
      const authorIds = [...new Set([...postRows.map(p => p.author_id), ...previewRows.map(p => p.author_id), ...(membershipResult.data || []).map(m => m.user_id), userId])];
      const [authorResult, countResult, likeResult] = await Promise.all([
        supabase.from('profiles').select('*').in('id', authorIds),
        ids.length ? supabase.from('post_counts').select('post_id,like_count,comment_count').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('likes').select('post_id,user_id').eq('user_id', userId).in('post_id', ids) : Promise.resolve({ data: [], error: null }),
      ]);
      const secondError = [authorResult, countResult, likeResult].find(r => r.error);
      if (secondError) throw secondError.error;
      if (request !== communityRequest.current || userId !== communityUser.current) return;
      // Every real member has a profile (created at sign-up). Without one, the account wasn't set up properly.
      if (!(authorResult.data || []).some(p => p.id === userId)) { await rejectAccount('errNoProfile'); return; }
      const byId = new Map([...(recentProfiles.data || []), ...(authorResult.data || [])].map(p => [p.id, p]));
      setProfiles([...byId.values()]); setPosts(postRows);
      setGroupPreviews(Object.fromEntries(previewRows.map(post => [post.group_id, post])));
      setCommunityRevision(value => value + 1);
      setGroups(groupResult.data || []); setGroupMembers(membershipResult.data || []);
      setCounts(countResult.data || []); setLikes(likeResult.data || []);
      setFollows(followResult.data || []); setError('');
    } catch (err) { if (request === communityRequest.current && userId === communityUser.current) setError(err.message || translate(langRef.current, 'errLoadCommunity')); }
    finally { if (spin && request === communityRequest.current && userId === communityUser.current) setLoading(false); }
  }, [userId, rejectAccount]);
  useEffect(() => {
    if (!userId) return undefined;
    const term = audienceQuery.trim().replace(/[%_]/g, '');
    if (!term || postAudience !== 'selected') { setAudienceMatches([]); return undefined; }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const profilesForAudience = await searchAudienceProfiles(term, userId);
        if (active) setAudienceMatches(profilesForAudience);
      } catch (err) { if (active) setError(err.message || t('errAction')); }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [userId, audienceQuery, postAudience]);
  useEffect(() => {
    if (!userId || editingPost?.audience !== 'selected') { setEditAudienceMatches([]); return undefined; }
    const term = editAudienceQuery.trim().replace(/[%_]/g, '');
    if (!term) { setEditAudienceMatches([]); return undefined; }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const profilesForAudience = await searchAudienceProfiles(term, userId);
        if (active) setEditAudienceMatches(profilesForAudience);
      } catch (err) { if (active) setError(err.message || t('errAction')); }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [userId, editAudienceQuery, editingPost?.audience]);
  useEffect(() => {
    if (!userId) {
      setSavedPostIds([]);
      setSavedPostCollections({});
      setSavedCollections([]);
      setSavedCollectionFilter('all');
      setSavedIdsLoading(false);
      setSavedPosts([]);
      return undefined;
    }
    let active = true;
    setSavedIdsLoading(true);
    (async () => {
      const [savedResult, collectionResult] = await Promise.all([
        supabase.from('saved_posts').select('post_id,collection_id').eq('user_id', userId).order('created_at', { ascending: false }),
        supabase.from('saved_collections').select('id,name').eq('user_id', userId).order('created_at', { ascending: true }),
      ]);
      if (!active) return;
      const savedError = savedResult.error || collectionResult.error;
      if (savedError) {
        setError(/PGRST205|42P01/.test(`${savedError.code} ${savedError.message}`) ? t('errSavedPostsSetup') : savedError.message);
        setSavedIdsLoading(false);
        return;
      }
      const savedRows = savedResult.data || [];
      const collections = collectionResult.data || [];
      setSavedPostIds(savedRows.map(row => row.post_id));
      setSavedPostCollections(Object.fromEntries(savedRows.map(row => [row.post_id, row.collection_id])));
      setSavedCollections(collections);
      setSavedCollectionFilter(current => current === 'all' || current === 'uncategorized' || collections.some(collection => collection.id === current) ? current : 'all');
      setSavedIdsLoading(false);
    })();
    return () => { active = false; };
  }, [userId, savedRevision]);
  useEffect(() => {
    const request = ++savedPostsRequest.current;
    if (!userId || tab !== 'saved') { setSavedLoading(false); return undefined; }
    if (savedIdsLoading) { setSavedLoading(true); return undefined; }
    if (!savedPostIds.length) { setSavedPosts([]); setSavedLoading(false); return undefined; }
    let active = true;
    setSavedLoading(true);
    (async () => {
      try {
        const { data, error: postsError } = await supabase.from('posts').select('*').in('id', savedPostIds);
        if (postsError) throw postsError;
        const rows = data || [];
        const authorIds = [...new Set(rows.map(post => post.author_id))];
        const postIds = rows.map(post => post.id);
        const [authorResult, countResult, likeResult] = await Promise.all([
          authorIds.length ? supabase.from('profiles').select('*').in('id', authorIds) : Promise.resolve({ data: [], error: null }),
          postIds.length ? supabase.from('post_counts').select('post_id,like_count,comment_count').in('post_id', postIds) : Promise.resolve({ data: [], error: null }),
          postIds.length ? supabase.from('likes').select('post_id,user_id').eq('user_id', userId).in('post_id', postIds) : Promise.resolve({ data: [], error: null }),
        ]);
        const queryError = [authorResult, countResult, likeResult].find(result => result.error);
        if (queryError) throw queryError.error;
        if (!active || request !== savedPostsRequest.current) return;
        setSavedPosts(orderVisibleSavedPosts(savedPostIds, rows));
        setProfiles(prev => mergeRows(prev, authorResult.data || [], 'id'));
        setCounts(prev => mergeRows(prev, countResult.data || [], 'post_id'));
        setLikes(prev => [...new Map([...prev, ...(likeResult.data || [])].map(like => [like.post_id, like])).values()]);
      } catch (err) {
        if (active && request === savedPostsRequest.current) setError(err.message || t('errLoadCommunity'));
      } finally {
        if (active && request === savedPostsRequest.current) setSavedLoading(false);
      }
    })();
    return () => { active = false; };
  }, [userId, tab, savedPostIds, savedIdsLoading]);
  useEffect(() => {
    if (!userId || tab !== 'groups') return undefined;
    const term = memberQuery.trim().replace(/[%_]/g, '');
    if (!term) { setMemberMatches([]); return undefined; }
    let active = true;
    const timer = setTimeout(async () => {
      const [handles, names] = await Promise.all([
        supabase.from('profiles').select('id,handle,display_name,avatar_path').ilike('handle', `%${term}%`).limit(15),
        supabase.from('profiles').select('id,handle,display_name,avatar_path').ilike('display_name', `%${term}%`).limit(15),
      ]);
      if (!active) return;
      if (handles.error || names.error) { setError((handles.error || names.error).message); return; }
      setMemberMatches([...new Map([...(handles.data || []), ...(names.data || [])].filter(p => p.id !== userId).map(p => [p.id, p])).values()].slice(0, 20));
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [userId, tab, memberQuery]);
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
    if (!chatIdentityRef.current?.privateKey) { setMessages([]); return; }
    const requestId = ++messageRequest.current;
    try {
      const result = await loadEncryptedConversation(supabase, userId, recipient, chatIdentityRef.current);
      if (requestId !== messageRequest.current || recipient !== recipientRef.current) return;
      setMessages(result.messages); setRecipientKey(result.recipientKey);
      setRecipientFingerprint(result.recipientFingerprint); setError('');
      if (document.visibilityState === 'visible' && result.messages.some(m => m.sender_id === recipient && m.read_at === null)) {
        await supabase.rpc('mark_messages_read', { other_user: recipient });
      }
    } catch (err) {
      if (requestId === messageRequest.current) setError(err.message || t('errMessage'));
    }
  }, [userId, recipient]);
  useEffect(() => {
    if (!userId) { setChatIdentity(null); setBlockedIds([]); return undefined; }
    let active = true;
    setChatKeyLoading(true);
    Promise.all([
      loadChatIdentity(supabase, userId),
      supabase.from('user_blocks').select('blocked_id').eq('blocker_id', userId),
    ]).then(([identity, blockResult]) => {
      if (!active) return;
      if (blockResult.error) throw blockResult.error;
      setChatIdentity(identity); setRecoveryCode(identity.recoveryCode || '');
      setBlockedIds((blockResult.data || []).map(b => b.blocked_id));
    }).catch(err => { if (active) setError(err.message || 'Could not load private chat.'); })
      .finally(() => { if (active) setChatKeyLoading(false); });
    return () => { active = false; };
  }, [userId]);
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
  useEffect(() => { recipientRef.current = recipient; messageRequest.current += 1; setMessages([]); setRecipientKey(null); setRecipientFingerprint(''); }, [recipient, userId]);
  useEffect(() => {
    if (!userId || !recipient || !recipientFingerprint) { setVerifiedRecipientFingerprint(''); return; }
    try {
      const saved = localStorage.getItem(`campconnect:verified-key:${userId}:${recipient}`);
      setVerifiedRecipientFingerprint(saved === recipientFingerprint ? saved : '');
    } catch { setVerifiedRecipientFingerprint(''); }
  }, [userId, recipient, recipientFingerprint]);
  useEffect(() => { if (tab === 'messages' && chatIdentity?.privateKey) loadMessages(); }, [tab, loadMessages, chatIdentity]);
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
      const term = query.trim().replace(/[\\%_]/g, '\\$&');
      const [handles, names] = await Promise.all([
        supabase.from('profiles').select('*').ilike('handle', `%${term}%`).order('created_at', { ascending: false }).limit(50),
        supabase.from('profiles').select('*').ilike('display_name', `%${term}%`).order('created_at', { ascending: false }).limit(50),
      ]);
      if (!cancelled) {
        const searchError = handles.error || names.error;
        if (searchError) { setError(searchError.message); setSearchResults([]); }
        else setSearchResults([...new Map([...(handles.data || []), ...(names.data || [])].map(person => [person.id, person])).values()]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50));
        setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [userId, tab, query]);
  useEffect(() => {
    if (!userId) return undefined;
    // Keep checking for new activity in background tabs too, so sounds still play.
    const timer = setInterval(() => { loadNotifications(); if (document.visibilityState === 'visible') { if (tab === 'messages') loadMessages(); if (tab === 'groups') loadCommunity(); } }, 15000);
    return () => clearInterval(timer);
  }, [userId, tab, loadMessages, loadNotifications]);
  // Notification sounds: play when something new arrives since the last check —
  // a message, a post, a like or comment on my post, or a new follower.
  const known = useRef(null); // keys of everything that was already there at the last check
  useEffect(() => {
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    return () => { document.removeEventListener('pointerdown', unlockAudio); document.removeEventListener('keydown', unlockAudio); };
  }, []);
  useEffect(() => { known.current = null; }, [userId]);
  useEffect(() => {
    if (followers === null) return; // notifications haven't loaded yet
    const messageKeys = incoming.map(m => `${m.sender_id}:${m.created_at}`);
    const activityKeys = [
      ...activity.posts.map(p => `post:${p.id}`),
      ...activity.likes.map(l => `like:${l.post_id}:${l.user_id}`),
      ...activity.comments.map(c => `comment:${c.id}`),
      ...followers.map(id => `follow:${id}`),
    ];
    const before = known.current;
    known.current = { messages: new Set(messageKeys), activity: new Set(activityKeys) };
    if (!before) return; // the first load after signing in is not "new"
    // No ding for a chat I'm already looking at.
    const watching = sender => tab === 'messages' && recipient === sender && document.visibilityState === 'visible';
    const newMessage = incoming.some(m => !before.messages.has(`${m.sender_id}:${m.created_at}`) && !watching(m.sender_id));
    const newActivity = activityKeys.some(key => !before.activity.has(key));
    if (newMessage) playSound('message');
    else if (newActivity) playSound('activity');
  }, [incoming, activity, followers]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Show the unread total on the browser tab, e.g. "(3) CampConnect".
  useEffect(() => {
    const total = userId ? unreadNotifications + unreadMessages : 0;
    document.title = total ? `(${total > 99 ? '99+' : total}) CampConnect` : 'CampConnect - Social Network App';
  }, [userId, unreadNotifications, unreadMessages]);
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
  const profileMap = useMemo(() => new Map([...notifyProfiles, ...profiles, ...groupHistory.authors, ...searchResults, ...(selectedProfile ? [selectedProfile] : [])].map(p => [p.id, p])), [notifyProfiles, profiles, groupHistory.authors, searchResults, selectedProfile]);
  const mine = profileMap.get(userId);
  const followingIds = new Set(follows.map(f => f.following_id));
  const followerIds = new Set(followers || []);
  const others = [...new Map([...notifyProfiles, ...profiles, ...groupHistory.authors, ...searchResults, ...(selectedProfile ? [selectedProfile] : [])].filter(p => p.id !== userId).map(p => [p.id, p])).values()];
  const filtered = (query.trim() ? searchResults.filter(p => p.id !== userId) : others)
    .sort((a, b) => newFollowerIds.includes(b.id) - newFollowerIds.includes(a.id));
  const contacts = [...others].sort((a, b) => (unreadBySender[b.id] || 0) - (unreadBySender[a.id] || 0));
  const badges = { notifications: unreadNotifications, people: unseenFollowers.length, messages: unreadMessages };
  const badgeText = n => (n > 99 ? '99+' : n);
  // Unread count on the installed app's icon (where the browser supports it).
  const totalUnread = badges.notifications + badges.people + badges.messages;
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return;
    (totalUnread > 0 ? navigator.setAppBadge(totalUnread) : navigator.clearAppBadge()).catch(() => {});
  }, [totalUnread]);
  async function mutate(key, operation, after) {
    setBusy(key); setError('');
    try {
      const result = await operation();
      if (result.error) throw result.error;
      if (after) after();
      await loadCommunity();
      if (tab === 'profile' && viewProfileId) await loadProfile(viewProfileId);
      if (tab === 'post' && focusPost.id) await loadFocusPost(focusPost.id);
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  async function toggleSavedPost(post) {
    const isSaved = savedPostIds.includes(post.id);
    setBusy('save');
    setError('');
    try {
      const result = isSaved
        ? await supabase.from('saved_posts').delete().eq('user_id', userId).eq('post_id', post.id)
        : await supabase.from('saved_posts').insert({ user_id: userId, post_id: post.id, collection_id: null });
      if (result.error) throw result.error;
      setSavedPostIds(prev => isSaved ? prev.filter(id => id !== post.id) : [post.id, ...prev]);
      if (isSaved) setSavedPostCollections(prev => { const next = { ...prev }; delete next[post.id]; return next; });
      else setSavedPostCollections(prev => ({ ...prev, [post.id]: null }));
      setFlash(t(isSaved ? 'postUnsaved' : 'postSaved'));
    } catch (err) {
      setError(/PGRST205|42P01/.test(`${err?.code} ${err?.message}`) ? t('errSavedPostsSetup') : err.message || t('errAction'));
    } finally { setBusy(''); }
  }
  async function createSavedCollection(e) {
    e.preventDefault();
    const name = newSavedCollection.trim();
    if (!name) return;
    setBusy('saved-collection');
    setError('');
    try {
      const { data, error: insertError } = await supabase.from('saved_collections').insert({ user_id: userId, name }).select('id,name').single();
      if (insertError) throw insertError;
      setSavedCollections(prev => [...prev, data]);
      setSavedCollectionFilter(data.id);
      setNewSavedCollection('');
      setFlash(t('savedCollectionCreated'));
    } catch (err) {
      setError(/PGRST205|42P01/.test(`${err?.code} ${err?.message}`)
        ? t('errSavedPostsSetup')
        : err?.code === '23505' ? t('savedCollectionExists') : err.message || t('errAction'));
    } finally { setBusy(''); }
  }
  // Deleting a collection keeps its posts saved: the database sets their collection
  // to "No collection" (saved_posts.collection_id is ON DELETE SET NULL in 0017).
  async function deleteSavedCollection(collection) {
    setBusy('saved-collection');
    setError('');
    try {
      const { error: deleteError } = await supabase.from('saved_collections').delete().eq('id', collection.id).eq('user_id', userId);
      if (deleteError) throw deleteError;
      setSavedCollections(prev => prev.filter(c => c.id !== collection.id));
      setSavedPostCollections(prev => Object.fromEntries(Object.entries(prev).map(([postId, c]) => [postId, c === collection.id ? null : c])));
      setSavedCollectionFilter('all');
      setFlash(t('collectionDeleted', { name: collection.name }));
    } catch (err) {
      setError(/PGRST205|42P01/.test(`${err?.code} ${err?.message}`) ? t('errSavedPostsSetup') : err.message || t('errAction'));
    } finally { setBusy(''); }
  }
  async function assignSavedCollection(postId, collectionId) {
    const nextCollectionId = collectionId || null;
    setBusy('saved-collection');
    setError('');
    try {
      const { error: updateError } = await supabase.from('saved_posts').update({ collection_id: nextCollectionId }).eq('user_id', userId).eq('post_id', postId);
      if (updateError) throw updateError;
      setSavedPostCollections(prev => ({ ...prev, [postId]: nextCollectionId }));
      const target = savedCollections.find(collection => collection.id === nextCollectionId);
      setFlash(target ? t('movedToCollection', { name: target.name }) : t('removedFromCollection'));
    } catch (err) {
      setError(/PGRST205|42P01/.test(`${err?.code} ${err?.message}`)
        ? t('errSavedPostsSetup')
        : err.message || t('errAction'));
    } finally { setBusy(''); }
  }
  // Storage missing (0005 not run yet) shows a setup hint instead of a raw error.
  const imageErrorText = err => (/bucket not found|image_path|avatar_path|PGRST204|42703/i.test(`${err?.message} ${err?.code}`) ? t('errImageSetup') : err?.message || t('errAction'));
  const editErrorText = err => (/image_paths|PGRST202|PGRST204|42501|42703/i.test(`${err?.message} ${err?.code}`) ? t('errEditSetup') : imageErrorText(err));
  // Cleanup is best-effort: a failed deletion must never undo a saved post/photo
  // or hide the original upload/update error. Notices survive data refreshes.
  async function cleanupImages(bucket, paths) {
    try { await removeImages(bucket, paths); }
    catch { setNotice(t('imageCleanupWarning')); }
  }
  // Turn picked files into previews, keeping the total at MAX_IMAGES.
  function pickImages(e, existingCount, add) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (postAudience !== 'school' && e.target === postImageInput.current) { setError(t('restrictedTextOnly')); return; }
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
    } catch (err) { await cleanupImages(POST_IMAGE_BUCKET, paths); throw err; }
  }
  async function publish(e) {
    e.preventDefault(); const body = postText.trim();
    if ((!body && !postImages.length) || body.length > MAX_POST) return;
    if (postAudience !== 'school' && (!body || postImages.length)) { setError(t('restrictedTextOnly')); return; }
    if (postAudience === 'selected' && !chosenStudents.length) { setError(t('chooseRecipients')); return; }
    if (postAudience === 'group' && !postGroup) { setError(t('chooseGroup')); return; }
    setBusy('post'); setError('');
    let paths = [];
    let saved = false;
    try {
      paths = await uploadPostImages(postImages);
      const { error: err } = await supabase.rpc('create_audience_post', {
        p_body: body, p_audience: postAudience,
        p_user_ids: postAudience === 'selected' ? chosenStudents.map(p => p.id) : null,
        p_group_id: postAudience === 'group' ? postGroup : null,
        p_image_paths: paths,
      });
      if (err) throw err;
      saved = true;
      setPostText(''); dropPreviews(postImages); setPostImages([]); setChosenStudents([]); setAudienceQuery('');
      await loadCommunity();
    } catch (err) {
      if (!saved) await cleanupImages(POST_IMAGE_BUCKET, paths);
      setError(paths.length > 1 ? editErrorText(err) : imageErrorText(err));
    } finally { setBusy(''); }
  }
  async function postToBoard(e) {
    e.preventDefault(); const body = boardText.trim();
    if (!body || body.length > MAX_POST || !currentGroup) return;
    setBusy('board'); setError('');
    try {
      const { error: err } = await supabase.rpc('create_audience_post', {
        p_body: body, p_audience: 'group', p_user_ids: null, p_group_id: currentGroup.id, p_image_paths: [],
      });
      if (err) throw err;
      setBoardText(''); await loadCommunity();
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  async function createGroup(e) {
    e.preventDefault();
    if (!groupName.trim()) return;
    setBusy('group'); setError('');
    try {
      const { data, error: err } = await supabase.rpc('create_student_group', { p_name: groupName.trim() });
      if (err) throw err;
      setGroupName(''); setShowCreateGroup(false); setActiveGroup(data); setGroupView('thread');
      await loadCommunity();
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  async function submitReport(reason, note) {
    const target = reportTarget; if (!target) return;
    setBusy('report'); setError('');
    const { error: err } = await supabase.rpc('report_content', { p_target_type: target.type, p_target_id: target.id, p_reason: reason, p_note: note });
    setBusy('');
    if (err) { setError(err.message || t('errAction')); return; }
    setReportTarget(null); setFlash(t('reportSent'));
  }
  async function renameGroup(e) {
    e.preventDefault();
    const name = groupEditName.trim();
    if (!name || !currentGroup) return;
    setBusy('group'); setError('');
    try {
      const { error: err } = await supabase.rpc('rename_student_group', { p_group_id: currentGroup.id, p_name: name });
      if (err) throw err;
      setGroupEditName(null); await loadCommunity();
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  async function changeGroupAvatar(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file || !currentGroup) return;
    if (!isImageFile(file)) { setError(t('errImageType')); return; }
    const oldPath = currentGroup.avatar_path;
    setBusy('group-photo'); setError('');
    let newPath = null;
    let saved = false;
    try {
      newPath = await uploadImage(AVATAR_BUCKET, userId, await shrinkImage(file, 512, true));
      const { error: err } = await supabase.rpc('set_student_group_avatar', { p_group_id: currentGroup.id, p_avatar_path: newPath });
      if (err) throw err;
      saved = true;
      await cleanupImages(AVATAR_BUCKET, oldPath ? [oldPath] : []);
      await loadCommunity();
    } catch (err) {
      if (!saved && newPath) await cleanupImages(AVATAR_BUCKET, [newPath]);
      setError(imageErrorText(err));
    } finally { setBusy(''); }
  }
  async function changeGroupMember(groupId, personId, remove = false) {
    setBusy('group-member'); setError('');
    try {
      const { error: err } = await supabase.rpc(remove ? 'remove_student_group_member' : 'add_student_group_member', {
        p_group_id: groupId, p_user_id: personId,
      });
      if (err) throw err;
      setMemberQuery(''); await loadCommunity();
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  const deletePost = post => mutate('delete', async () => {
    const result = await supabase.from('posts').delete().eq('id', post.id);
    if (!result.error) await cleanupImages(POST_IMAGE_BUCKET, postImagePaths(post));
    if (!result.error) setGroupHistory(history => ({ ...history, posts: history.posts.filter(item => item.id !== post.id) }));
    return result;
  }, () => { if (tab === 'post') setTab('feed'); });
  async function startEditPost(post) {
    setMenuPost('');
    setBusy('edit');
    setError('');
    try {
      let recipients = [];
      if (post.audience === 'selected') {
        const { data: recipientRows, error: recipientError } = await supabase.from('post_recipients').select('user_id').eq('post_id', post.id);
        if (recipientError) throw recipientError;
        const recipientIds = (recipientRows || []).map(row => row.user_id);
        if (recipientIds.length) {
          const { data: profilesForRecipients, error: profilesError } = await supabase.from('profiles').select('id,handle,display_name,avatar_path').in('id', recipientIds);
          if (profilesError) throw profilesError;
          recipients = profilesForRecipients || [];
        }
      }
      const paths = postImagePaths(post);
      setEditingPost({
        id: post.id, audience: post.audience || 'school', groupId: post.group_id || '',
        recipients, body: post.body || '', keep: paths, added: [], original: paths,
      });
      setAudienceQuery('');
      setEditAudienceQuery('');
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
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
    if (editingPost.audience !== 'school' && (!body || keep.length || added.length)) { setError(t('restrictedTextOnly')); return; }
    if (editingPost.audience === 'selected' && !editingPost.recipients.length) { setError(t('chooseRecipients')); return; }
    if (editingPost.audience === 'group' && !editingPost.groupId) { setError(t('chooseGroup')); return; }
    setBusy('edit'); setError('');
    let newPaths = [];
    let saved = false;
    try {
      if (editingPost.audience === 'school') newPaths = await uploadPostImages(added);
      const { error: err } = await supabase.rpc('edit_audience_post', buildAudienceEditPayload(editingPost, newPaths));
      if (err) throw err;
      saved = true;
      await cleanupImages(POST_IMAGE_BUCKET, original.filter(p => !keep.includes(p)));
      dropPreviews(added); setEditingPost(null);
      await loadCommunity();
      if (tab === 'profile' && viewProfileId) await loadProfile(viewProfileId);
      if (tab === 'post') await loadFocusPost(id);
    } catch (err) {
      if (!saved) await cleanupImages(POST_IMAGE_BUCKET, newPaths);
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
    let saved = false;
    try {
      newPath = await uploadImage(AVATAR_BUCKET, userId, await shrinkImage(file, 512, true));
      const { data, error: err } = await supabase.from('profiles').update({ avatar_path: newPath }).eq('id', userId).select('id');
      if (err) throw err;
      if (!data?.length) throw new Error(t('errAction'));
      saved = true;
      await cleanupImages(AVATAR_BUCKET, oldPath ? [oldPath] : []);
      setFlash(t('photoUpdated'));
      await Promise.all([loadProfile(userId), loadCommunity()]);
    } catch (err) {
      if (!saved && newPath) await cleanupImages(AVATAR_BUCKET, [newPath]);
      setError(imageErrorText(err));
    } finally { setBusy(''); }
  }
  async function removeAvatar() {
    const oldPath = profileView.data?.avatar_path;
    if (!oldPath) return;
    setBusy('photo'); setError('');
    try {
      const { data, error: err } = await supabase.from('profiles').update({ avatar_path: null }).eq('id', userId).select('id');
      if (err) throw err;
      if (!data?.length) throw new Error(t('errAction'));
      await cleanupImages(AVATAR_BUCKET, [oldPath]);
      await Promise.all([loadProfile(userId), loadCommunity()]);
    } catch (err) { setError(imageErrorText(err)); }
    finally { setBusy(''); }
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
    if (!recipientFingerprint || verifiedRecipientFingerprint !== recipientFingerprint) {
      setError(t('verifyContactKeyFirst')); return;
    }
    setBusy('message'); setError('');
    try {
      await sendEncryptedMessage(supabase, userId, recipient, body, chatIdentity, recipientFingerprint);
      setMessageText(''); await loadMessages();
    } catch (err) { setError(err.message || t('errMessage')); }
    finally { setBusy(''); }
  }
  async function enableChat() {
    setBusy('chat-key'); setError('');
    try {
      const identity = await registerChatIdentity(supabase, userId);
      setChatIdentity(identity); setRecoveryCode(identity.recoveryCode || '');
    } catch (err) { setError(err.message || t('errMessage')); }
    finally { setBusy(''); }
  }
  async function restoreChat(e) {
    e.preventDefault(); setBusy('chat-restore'); setError('');
    try {
      const identity = await recoverChatIdentity(supabase, userId, recoveryInput.trim());
      setChatIdentity(identity); setRecoveryInput('');
    } catch (err) { setError(err.message || t('errMessage')); }
    finally { setBusy(''); }
  }
  async function resetChat() {
    askConfirm(t('confirmResetChat'), t('resetChatKey'), async () => {
      setBusy('chat-reset'); setError('');
      try {
        const identity = await resetChatIdentity(supabase, userId);
        setChatIdentity(identity); setRecoveryCode(identity.recoveryCode);
        setMessages([]); setRecipientKey(null); setRecipientFingerprint('');
      } catch (err) { setError(err.message || t('errMessage')); }
      finally { setBusy(''); }
    });
  }
  function verifyRecipientKey() {
    if (!userId || !recipient || !recipientFingerprint) return;
    try { localStorage.setItem(`campconnect:verified-key:${userId}:${recipient}`, recipientFingerprint); }
    catch { setError(t('cannotRememberKey')); }
    setVerifiedRecipientFingerprint(recipientFingerprint);
  }
  async function toggleBlock() {
    if (!recipient) return;
    const blocked = blockedIds.includes(recipient);
    setBusy('block'); setError('');
    try {
      const operation = blocked
        ? supabase.from('user_blocks').delete().eq('blocker_id', userId).eq('blocked_id', recipient)
        : supabase.from('user_blocks').insert({ blocker_id: userId, blocked_id: recipient });
      const { error: err } = await operation;
      if (err) throw err;
      setBlockedIds(prev => blocked ? prev.filter(id => id !== recipient) : [...prev, recipient]);
    } catch (err) { setError(err.message || t('errAction')); }
    finally { setBusy(''); }
  }
  function openNotification(n) {
    if (n.kind === 'follow') { openProfile(n.actor); return; }
    if (n.kind === 'comment') { setOpenComments(prev => ({ ...prev, [n.postId]: true })); loadComments(n.postId); }
    openPost(n.postId);
  }
  // Sharing: every post has its own link, e.g. https://…/CampConnect/?post=<id>
  const postLink = id => `${window.location.origin}${window.location.pathname}?post=${id}`;
  const postIdFromLink = url => {
    try {
      const u = new URL(url);
      return u.origin === window.location.origin && u.pathname === window.location.pathname ? u.searchParams.get('post') : null;
    } catch { return null; }
  };
  async function copyPostLink(post) {
    setMenuPost('');
    const link = postLink(post.id);
    try { await navigator.clipboard.writeText(link); }
    catch {
      // Older or locked-down browsers: fall back to a hidden text box.
      const box = Object.assign(document.createElement('textarea'), { value: link });
      document.body.append(box); box.select(); document.execCommand('copy'); box.remove();
    }
    setFlash(t('linkCopied'));
  }
  async function nativeShare(post) {
    setMenuPost('');
    try { await navigator.share({ title: 'CampConnect', text: post.body ? snip(post.body, 100) : t('sharedPostIntro'), url: postLink(post.id) }); }
    catch { /* the person closed the share sheet */ }
  }
  async function sendShare(person) {
    const post = shareTarget;
    setShareTarget(null); setShareQuery('');
    setRecipient(person.id); setTab('messages');
    setMessageText(`${t('sharedPostIntro')}\n${postLink(post.id)}`);
    setFlash(t('shareDraftReady'));
  }
  const loadFocusPost = useCallback(async id => {
    const { data, error: err } = await supabase.from('posts').select('*').eq('id', id).maybeSingle();
    if (err) { setError(err.message); setFocusPost({ id, post: null, loading: false }); return; }
    if (data) {
      const [authorResult, countResult, likeResult] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', data.author_id).maybeSingle(),
        supabase.from('post_counts').select('post_id,like_count,comment_count').eq('post_id', id),
        supabase.from('likes').select('post_id,user_id').eq('user_id', userId).eq('post_id', id),
      ]);
      if (authorResult.data) setProfiles(prev => mergeRows(prev, [authorResult.data], 'id'));
      if (!countResult.error) setCounts(prev => mergeRows(prev, countResult.data || [], 'post_id'));
      if (!likeResult.error) setLikes(prev => [...prev.filter(l => l.post_id !== id), ...(likeResult.data || [])]);
    }
    setFocusPost({ id, post: data, loading: false });
  }, [userId]);
  function openPost(id) {
    setFocusPost(prev => (prev.id === id ? prev : { id, post: null, loading: true }));
    setTab('post'); window.scrollTo({ top: 0 });
    loadFocusPost(id);
  }
  // Opening a shared link (…?post=<id>) shows that post once signed in.
  useEffect(() => {
    if (!userId) return;
    const id = new URLSearchParams(window.location.search).get('post');
    if (!id) return;
    window.history.replaceState(null, '', window.location.pathname);
    openPost(id);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Message text with clickable links; links to a CampConnect post open it here.
  function renderMessageBody(body) {
    return body.split(/(https?:\/\/[^\s]+)/g).map((part, i) => {
      if (i % 2 === 0) return part;
      const sharedId = postIdFromLink(part);
      if (sharedId) return <button key={i} type="button" className="shared-post-link" onClick={() => openPost(sharedId)}><Share2 size={14}/> {t('viewSharedPost')}</button>;
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
    });
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
    if (!form.display_name.trim()) { setError(t('errSignupFields')); return; }
    const orNull = v => (v.trim() ? v.trim() : null);
    setBusy('profile');
    // The username isn't sent: it always follows the school email (0018_username_from_email.sql).
    const { error: err } = await supabase.from('profiles').update({
      display_name: form.display_name.trim(),
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
    const saved = savedPostIds.includes(post.id);
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
        {post.author_id !== userId && <div className="post-menu">
          <button className="icon-button" aria-label={t('reportPost')} title={t('reportPost')} onClick={() => setReportTarget({ type: 'post', id: post.id })}><Flag size={16}/></button>
        </div>}
      </div>
      <div className="post-audience"><span className="tag">{post.audience === 'group' ? t('audienceGroupNamed', { name: groups.find(group => group.id === post.group_id)?.name || t('audienceGroup') }) : post.audience === 'selected' ? t('audienceSelected') : t('audienceSchool')}</span></div>
      {editing ? <form className="post-edit" onSubmit={saveEditPost}>
        <textarea aria-label={t('editPost')} value={editingPost.body} maxLength={MAX_POST} rows={3} onChange={e => setEditingPost(prev => ({ ...prev, body: e.target.value }))}/>
        <div className="audience-inline">
          <select aria-label={t('postAudience')} value={editingPost.audience} disabled={busy !== ''} onChange={e => {
            const audience = e.target.value;
            setEditingPost(prev => {
              if (audience === 'school') return { ...prev, audience };
              dropPreviews(prev.added);
              return { ...prev, audience, keep: [], added: [] };
            });
            setEditAudienceQuery('');
          }}>
            <option value="school">{t('audienceSchool')}</option>
            <option value="selected">{t('audienceSelected')}</option>
            <option value="group">{t('audienceGroup')}</option>
          </select>
          {editingPost.audience === 'selected' && <div className="audience-detail">
            <input aria-label={t('chooseStudents')} value={editAudienceQuery} disabled={busy !== ''} onChange={e => setEditAudienceQuery(e.target.value)} placeholder={t('chooseStudents')}/>
            {editingPost.recipients.length > 0 && <div className="selected-chips">{editingPost.recipients.map(person => <button type="button" key={person.id} className="tag" disabled={busy !== ''} onClick={() => setEditingPost(prev => ({ ...prev, recipients: prev.recipients.filter(recipient => recipient.id !== person.id) }))} aria-label={t('removeRecipient', { name: display(person) })}>{display(person)} ×</button>)}</div>}
            {editAudienceQuery.trim() && <div className="audience-results">{editAudienceMatches.filter(person => !editingPost.recipients.some(recipient => recipient.id === person.id)).map(person => <button type="button" key={person.id} onClick={() => { setEditingPost(prev => ({ ...prev, recipients: [...prev.recipients, person] })); setEditAudienceQuery(''); }}><Avatar profile={person}/><span>{display(person)} <small>@{person.handle}</small></span></button>)}</div>}
          </div>}
          {editingPost.audience === 'group' && <select aria-label={t('chooseGroup')} value={editingPost.groupId} disabled={busy !== ''} onChange={e => setEditingPost(prev => ({ ...prev, groupId: e.target.value }))}><option value="">{t('chooseGroup')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>}
          {editingPost.audience !== 'school' && <small className="muted">{t('restrictedTextOnly')}</small>}
        </div>
        {(editingPost.keep.length + editingPost.added.length) > 0 && <div className="image-previews">
          {editingPost.keep.map(p => <div className="image-preview" key={p}><img src={publicUrl(POST_IMAGE_BUCKET, p)} alt=""/><button type="button" className="preview-remove" aria-label={t('removeImage')} title={t('removeImage')} onClick={() => setEditingPost(prev => ({ ...prev, keep: prev.keep.filter(k => k !== p) }))}><X size={15}/></button></div>)}
          {editingPost.added.map((item, i) => <div className="image-preview" key={item.preview}><img src={item.preview} alt=""/><button type="button" className="preview-remove" aria-label={t('removeImage')} title={t('removeImage')} onClick={() => setEditingPost(prev => { dropPreviews([item]); return { ...prev, added: prev.added.filter((_, j) => j !== i) }; })}><X size={15}/></button></div>)}
        </div>}
        <div className="composer-footer"><div className="composer-tools">
          {editingPost.audience === 'school' && <button type="button" className="icon-button" disabled={busy !== '' || editingPost.keep.length + editingPost.added.length >= MAX_IMAGES} onClick={() => editImageInput.current?.click()} aria-label={t('addImage')} title={t('addImage')}><ImagePlus size={20}/></button>}
          <input ref={editImageInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e => pickImages(e, editingPost.keep.length + editingPost.added.length, items => setEditingPost(prev => ({ ...prev, added: [...prev.added, ...items] })))}/>
          <small>{editingPost.body.length}/{MAX_POST}</small>
        </div><div className="form-actions-inline"><button type="button" className="secondary" disabled={busy !== ''} onClick={cancelEditPost}>{t('cancel')}</button><button className="primary" disabled={busy !== '' || (!editingPost.body.trim() && !editingPost.keep.length && !editingPost.added.length)}>{busy === 'edit' ? t('saving') : t('saveProfile')}</button></div></div>
      </form> : <>
        {post.body && <p className="post-body">{post.body}</p>}
        {images.length > 0 && <div className={`post-images count-${Math.min(images.length, 4)}`}>{images.slice(0, 4).map((p, i) => <button type="button" key={p} className="post-image-cell" onClick={() => setLightbox({ paths: images, index: i, post })} aria-label={t('openImage', { i: i + 1, n: images.length })}><img src={publicUrl(POST_IMAGE_BUCKET, p)} alt={t('postImageAlt')} loading="lazy"/></button>)}</div>}
      </>}
      <div className="post-actions"><button className={liked ? 'active' : ''} disabled={busy !== ''} aria-label={liked ? t('unlikePost') : t('likePost')} onClick={() => mutate('like', () => liked ? supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', userId) : supabase.from('likes').insert({ post_id: post.id, user_id: userId }))}><Heart size={18} fill={liked ? 'currentColor' : 'none'}/>{count?.like_count ?? 0}</button><button aria-expanded={!!openComments[post.id]} onClick={() => { if (!openComments[post.id]) loadComments(post.id); setOpenComments(prev => ({ ...prev, [post.id]: !prev[post.id] })); }}><MessageCircle size={18}/>{count?.comment_count ?? 0}</button><button className={saved ? 'active' : ''} disabled={busy !== ''} aria-label={saved ? t('unsavePost') : t('savePost')} title={saved ? t('unsavePost') : t('savePost')} onClick={() => toggleSavedPost(post)}><Bookmark size={18} fill={saved ? 'currentColor' : 'none'}/></button>
        <div className="share-wrap"><button aria-label={t('share')} title={t('share')} aria-haspopup="menu" aria-expanded={menuPost === `share:${post.id}`} onClick={e => { e.stopPropagation(); setMenuPost(menuPost === `share:${post.id}` ? '' : `share:${post.id}`); }}><Share2 size={18}/> {t('share')}</button>
          {menuPost === `share:${post.id}` && <div className="menu panel share-menu" role="menu">
            <button role="menuitem" onClick={() => copyPostLink(post)}><Link size={16}/> {t('copyLink')}</button>
            <button role="menuitem" onClick={() => { setMenuPost(''); setShareTarget(post); }}><Send size={16}/> {t('sendInMessage')}</button>
            {typeof navigator.share === 'function' && <button role="menuitem" onClick={() => nativeShare(post)}><Share2 size={16}/> {t('shareVia')}</button>}
          </div>}
        </div>
      </div>
      {openComments[post.id] && <div className="comments"><h3>{t('comments')}</h3>{loadingComments[post.id] && <p className="muted">{t('loadingComments')}</p>}{!loadingComments[post.id] && postComments.length === 0 && <p className="muted">{t('noComments')}</p>}{postComments.map(c => <div className="comment" key={c.id}><PersonLink {...linkProps(c.author_id)}><Avatar profile={profileMap.get(c.author_id)}/></PersonLink><div><PersonLink {...linkProps(c.author_id)}><strong>{display(profileMap.get(c.author_id))}</strong></PersonLink><small> - {when(c.created_at)}</small>{c.author_id !== userId && <button type="button" className="icon-button report-comment" aria-label={t('reportComment')} title={t('reportComment')} onClick={() => setReportTarget({ type: 'comment', id: c.id })}><Flag size={13}/></button>}<p>{c.body}</p></div></div>)}<form onSubmit={e => addComment(e, post.id)} className="comment-form"><input aria-label={t('writeComment')} maxLength={MAX_COMMENT} placeholder={t('writeComment')} value={commentText[post.id] || ''} onChange={e => setCommentText(prev => ({ ...prev, [post.id]: e.target.value }))}/><button className="primary" disabled={busy !== '' || !commentText[post.id]?.trim()} aria-label={t('sendComment')}><Send size={16}/></button></form></div>}
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
          <label>{t('username')}<input value={`@${form.handle}`} readOnly aria-readonly="true" className="read-only"/><small>{t('usernameLocked')}</small></label>
          <label>{t('school')}<select value={form.school} onChange={setField('school')}><option value="">{t('chooseOne')}</option><option value="gaigo">{t('schoolGaigo')}</option><option value="itcollege">{t('schoolItcollege')}</option></select></label>
          <label>{t('course')}<input maxLength={80} value={form.course} onChange={setField('course')} placeholder={t('coursePlaceholder')}/></label>
          <label>{t('year')}<select value={form.year} onChange={setField('year')}><option value="">{t('chooseOne')}</option>{[1, 2, 3].map(n => <option key={n} value={n}>{t('yearValue', { n })}</option>)}</select></label>
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
  const navTitles = { feed: t('navFeed'), notifications: t('navNotifications'), people: t('navPeople'), groups: t('navGroups'), messages: t('navMessages'), saved: t('navSaved'), profile: t('navProfile'), post: t('postTitle') };
  const visibleSavedPostIds = savedCollectionFilter === 'all'
    ? savedPostIds
    : savedCollectionFilter === 'uncategorized'
      ? savedPostIds.filter(id => !savedPostCollections[id])
      : savedPostIds.filter(id => savedPostCollections[id] === savedCollectionFilter);
  const currentGroup = groups.find(group => group.id === activeGroup) || groups[0];
  const currentGroupId = currentGroup?.id || '';
  const groupPosts = groupHistory.id === currentGroupId ? groupHistory.posts : [];
  const lastGroupPost = groupId => groupPreviews[groupId];
  const sortedGroups = [...groups].sort((a, b) => new Date(lastGroupPost(b.id)?.created_at || b.created_at) - new Date(lastGroupPost(a.id)?.created_at || a.created_at));
  async function fetchGroupHistory(groupId, older = false, request = ++groupHistoryRequest.current) {
    const previous = groupHistory.id === groupId ? groupHistory : { posts: [], authors: [] };
    setGroupHistory(history => history.id === groupId ? { ...history, loading: true } : { id: groupId, posts: [], authors: [], hasMore: false, loading: true });
    const pageSize = older ? 50 : Math.min(999, Math.max(50, previous.posts.length));
    let query = supabase.from('posts').select('*').eq('audience', 'group').eq('group_id', groupId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(pageSize + 1);
    if (older && previous.posts.length) {
      const first = previous.posts[0];
      query = query.or(`created_at.lt.${first.created_at},and(created_at.eq.${first.created_at},id.lt.${first.id})`);
    }
    try {
      const { data, error: historyError } = await query;
      if (historyError) throw historyError;
      const page = (data || []).slice(0, pageSize);
      const authorIds = [...new Set(page.map(post => post.author_id))];
      const authors = authorIds.length ? await supabase.from('profiles').select('*').in('id', authorIds) : { data: [] };
      if (authors.error) throw authors.error;
      if (request !== groupHistoryRequest.current) return;
      if (older && threadRef.current) historyScroll.current = { height: threadRef.current.scrollHeight, top: threadRef.current.scrollTop };
      setGroupHistory(history => {
        const retained = older && history.id === groupId ? history : { posts: [], authors: [] };
        const merged = new Map([...retained.posts, ...page].map(post => [post.id, post]));
        return { id: groupId, posts: [...merged.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
          authors: [...new Map([...retained.authors, ...(authors.data || [])].map(person => [person.id, person])).values()],
          hasMore: (data || []).length > pageSize, loading: false };
      });
    } catch (err) {
      if (request !== groupHistoryRequest.current) return;
      setError(err.message || translate(langRef.current, 'errLoadCommunity'));
      setGroupHistory(history => ({ ...history, loading: false }));
    }
  }
  useEffect(() => {
    const request = ++groupHistoryRequest.current;
    historyScroll.current = null;
    if (!userId || tab !== 'groups' || !currentGroupId) { setGroupHistory({ id: '', posts: [], authors: [], hasMore: false, loading: false }); return undefined; }
    fetchGroupHistory(currentGroupId, false, request);
    return () => { groupHistoryRequest.current += 1; };
    // The revision refreshes the active thread after mutations and polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, tab, currentGroupId, communityRevision]);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (historyScroll.current) {
      el.scrollTop = historyScroll.current.top + el.scrollHeight - historyScroll.current.height;
      historyScroll.current = null;
    } else el.scrollTop = el.scrollHeight;
  }, [currentGroupId, groupPosts.length, tab, groupView]);
  const currentGroupMembers = currentGroup ? groupMembers.filter(member => member.group_id === currentGroup.id) : [];
  const viewingOther = tab === 'profile' && viewProfileId && viewProfileId !== userId;
  // "Sent" / "Seen" is shown under my most recent message only, like most chat apps.
  const lastMineIndex = messages.map(m => m.sender_id === userId).lastIndexOf(true);
  const shareCandidates = others.filter(p => {
    const q = shareQuery.trim().toLowerCase();
    return !q || display(p).toLowerCase().includes(q) || p.handle?.toLowerCase().includes(q);
  });
  if (!supabase) return <div className="auth-wrap"><div className="auth-card"><div className="brand">CampConnect</div><h1>{t('connectDbTitle')}</h1><p className="muted">{t('connectDbBody')}</p></div></div>;
  if (checking) return <div className="center-state">{t('loadingApp')}</div>;
  if (!session) return <><Auth notify={setNotice} t={t} lang={lang} onChangeLang={changeLang} theme={theme} onToggleTheme={toggleTheme}/>{notice && <div className="toast" role="status">{notice}</div>}</>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">CampConnect</div>
      <nav aria-label={t('mainNav')}>{[['feed', Home], ['notifications', Bell], ['people', Users], ['groups', UsersRound], ['messages', Mail], ['saved', Bookmark], ['profile', User]].map(([id, Icon]) => {
        // "Profile" in the menu means my own profile; viewing someone else's highlights nothing.
        const current = id === 'profile' ? tab === 'profile' && viewProfileId === userId : tab === id;
        return <button key={id} className={`nav-link ${current ? 'selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => (id === 'profile' ? openProfile(userId) : setTab(id))}><Icon size={20}/>{navTitles[id]}{badges[id] > 0 && <span className="badge" aria-label={t('newCount', { n: badges[id] })}>{badgeText(badges[id])}</span>}</button>;
      })}</nav>
      <div className="sidebar-bottom"><div className="prefs"><LangToggle t={t} lang={lang} onChange={changeLang}/><ThemeToggle t={t} theme={theme} onToggle={toggleTheme}/></div><div className="account-row"><button type="button" className="account" onClick={() => openProfile(userId)} title={t('viewProfile')}><Avatar profile={mine}/><div><strong>{display(mine)}</strong><small>@{mine?.handle || '...'}</small></div></button><button className="icon-button" aria-label={t('signOut')} title={t('signOut')} onClick={async () => { if (recoveryCode) { setError(t('saveRecoveryBeforeSignout')); setTab('messages'); return; } const { error: err } = await supabase.auth.signOut(); if (err) setError(err.message); else await clearLocalChatIdentity(userId).catch(() => {}); }}><LogOut size={18}/></button></div></div>
    </aside>
    <main className="main-panel">
      <header className="main-header"><div><p className="eyebrow">{t('yourCommunity')}</p><h1>{viewingOther ? display(profileMap.get(viewProfileId) || profileView.data) : navTitles[tab]}</h1></div><div className="header-actions">{tab === 'groups' && <button type="button" className={`icon-button ${showCreateGroup ? 'active' : ''}`} aria-label={t('createGroup')} title={t('createGroup')} aria-expanded={showCreateGroup} onClick={() => { setShowCreateGroup(v => !v); setGroupView('list'); }}><Plus size={20}/></button>}<button className="icon-button" title={t('refresh')} aria-label={t('refresh')} onClick={() => { loadCommunity(true); loadNotifications(); setSavedRevision(value => value + 1); if (tab === 'messages') loadMessages(); if (tab === 'profile') loadProfile(viewProfileId); }}><RefreshCw size={19}/></button></div></header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label={t('dismissError')}>x</button></div>}
      {notice && <div className="error-banner" role="status">{notice}<button onClick={() => setNotice('')} aria-label={t('dismissError')}>x</button></div>}
      {tab === 'feed' && <>
        <form className="composer panel" onSubmit={publish}><div className="composer-head"><Avatar profile={mine}/><label htmlFor="post-body">{t('shareThought')}</label></div><textarea id="post-body" value={postText} maxLength={MAX_POST} onChange={e => setPostText(e.target.value)} placeholder={t('whatsHappening')} rows={3}/><div className="audience-inline"><select aria-label={t('postAudience')} value={postAudience} onChange={e => { const next = e.target.value; if (next !== 'school') { dropPreviews(postImages); setPostImages([]); } setPostAudience(next); }}><option value="school">{t('audienceSchool')}</option><option value="selected">{t('audienceSelected')}</option><option value="group">{t('audienceGroup')}</option></select>
          {postAudience === 'selected' && <div className="audience-detail">
            <input aria-label={t('chooseStudents')} value={audienceQuery} onChange={e => setAudienceQuery(e.target.value)} placeholder={t('chooseStudents')}/>
            {chosenStudents.length > 0 && <div className="selected-chips">{chosenStudents.map(person => <button type="button" key={person.id} className="tag" onClick={() => setChosenStudents(prev => prev.filter(p => p.id !== person.id))} aria-label={t('removeRecipient', { name: display(person) })}>{display(person)} ×</button>)}</div>}
            {audienceQuery.trim() && <div className="audience-results">{audienceMatches.filter(p => !chosenStudents.some(chosen => chosen.id === p.id)).map(person => <button type="button" key={person.id} onClick={() => { setChosenStudents(prev => [...prev, person]); setAudienceQuery(''); }}><Avatar profile={person}/><span>{display(person)} <small>@{person.handle}</small></span></button>)}</div>}
          </div>}
          {postAudience === 'group' && <><select aria-label={t('chooseGroup')} value={postGroup} onChange={e => setPostGroup(e.target.value)}><option value="">{t('chooseGroup')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>{groups.length === 0 && <small>{t('createGroupFirst')}</small>}</>}
          {postAudience !== 'school' && <small className="muted">{t('restrictedTextOnly')}</small>}</div>{postImages.length > 0 && <div className="image-previews">{postImages.map((item, i) => <div className="image-preview" key={item.preview}><img src={item.preview} alt=""/><button type="button" className="preview-remove" onClick={() => removePostImage(i)} disabled={busy !== ''} aria-label={t('removeImage')} title={t('removeImage')}><X size={15}/></button></div>)}</div>}<div className="composer-footer"><div className="composer-tools"><button type="button" className="icon-button" disabled={busy !== '' || postAudience !== 'school' || postImages.length >= MAX_IMAGES} onClick={() => postImageInput.current?.click()} aria-label={t('addImage')} title={t('addImage')}><ImagePlus size={20}/></button><input ref={postImageInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e => pickImages(e, postImages.length, items => setPostImages(prev => [...prev, ...items]))}/><small>{postAudience === 'school' && `${t('imageCount', { n: postImages.length, max: MAX_IMAGES })} · `}{postText.length}/{MAX_POST}</small></div><button className="primary" disabled={busy !== '' || (!postText.trim() && !postImages.length)}><Send size={16}/> {busy === 'post' ? t('uploading') : t('post')}</button></div></form>
        <div className="section-heading"><h2>{t('latestPosts')}</h2>{loading && <span>{t('loading')}</span>}</div>
        {!loading && posts.length === 0 && <div className="empty panel">{t('noPosts')}</div>}
        {posts.map(renderPost)}
      </>}
      {tab === 'saved' && <div className="saved-posts">
        <div className="section-heading"><h2>{navTitles.saved}</h2>{savedLoading && <span>{t('loading')}</span>}</div>
        <div className="saved-tools panel">
          {/* Facebook-style: "All" plus one button per collection. */}
          <div className="collection-chips" role="group" aria-label={t('filterSaved')}>
            <button type="button" className={`chip ${savedCollectionFilter === 'all' ? 'active' : ''}`} aria-pressed={savedCollectionFilter === 'all'} onClick={() => setSavedCollectionFilter('all')}><Bookmark size={15}/> {t('allSaved')} <span className="chip-count">{savedPostIds.length}</span></button>
            {savedCollections.map(collection => {
              const active = savedCollectionFilter === collection.id;
              return <span key={collection.id} className={`chip-group ${active ? 'active' : ''}`}>
                <button type="button" className={`chip ${active ? 'active' : ''}`} aria-pressed={active} onClick={() => setSavedCollectionFilter(collection.id)}><Folder size={15}/> {collection.name} <span className="chip-count">{savedPostIds.filter(id => savedPostCollections[id] === collection.id).length}</span></button>
                {active && <button type="button" className="chip-delete" disabled={busy !== ''} aria-label={t('deleteCollection')} title={t('deleteCollection')} onClick={() => askConfirm(t('confirmDeleteCollection', { name: collection.name }), t('deleteCollection'), () => deleteSavedCollection(collection))}><Trash2 size={15}/></button>}
              </span>;
            })}
          </div>
          <form className="saved-collection-create" onSubmit={createSavedCollection}>
            <label htmlFor="saved-collection-name">{t('newCollection')}</label>
            <div><input id="saved-collection-name" maxLength={50} value={newSavedCollection} onChange={e => setNewSavedCollection(e.target.value)} placeholder={t('collectionName')} />
              <button className="primary" disabled={busy !== '' || !newSavedCollection.trim()}><Plus size={16}/>{t('createCollection')}</button></div>
          </form>
        </div>
        {!savedLoading && savedPostIds.length === 0 && <div className="empty panel">{t('noSavedPosts')}</div>}
        {!savedLoading && savedPostIds.length > 0 && visibleSavedPostIds.length === 0 && <div className="empty panel">{t('noSavedInCollection')}</div>}
        {visibleSavedPostIds.map(id => {
          const post = savedPosts.find(saved => saved.id === id);
          return post
            ? <div className="saved-post-entry" key={id}>
                {savedCollections.length > 0 && <label className="saved-post-category"><FolderInput size={16} aria-hidden="true"/><select aria-label={t('addToCollection')} value={savedPostCollections[id] || ''} disabled={busy !== ''} onChange={e => assignSavedCollection(id, e.target.value)}>
                  <option value="">{savedPostCollections[id] ? t('removeFromCollection') : t('addToCollection')}</option>
                  {savedCollections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
                </select></label>}
                {renderPost(post)}
              </div>
            : <article className="empty panel saved-unavailable" key={id}><span>{t('savedPostUnavailable')}</span><button type="button" className="secondary" disabled={busy !== ''} onClick={() => toggleSavedPost({ id })}>{t('unsavePost')}</button></article>;
        })}
      </div>}
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
      {tab === 'groups' && <div className="groups-layout" data-view={groupView}>
        <input ref={groupAvatarInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={changeGroupAvatar}/>
        <aside className="group-list-pane panel" aria-label={t('yourGroups')}>
          {(showCreateGroup || groups.length === 0) && <form className="group-create-row" onSubmit={createGroup}><input aria-label={t('groupName')} maxLength={80} value={groupName} onChange={e => setGroupName(e.target.value)} placeholder={t('groupName')}/><button className="primary" disabled={busy !== '' || !groupName.trim()} aria-label={t('createGroup')}><Check size={16}/></button></form>}
          <div className="group-rows">
            {groups.length === 0 && <p className="muted">{t('noGroups')}</p>}
            {sortedGroups.map(group => { const last = lastGroupPost(group.id); const author = last && profileMap.get(last.author_id);
              return <button type="button" key={group.id} className={`group-row ${currentGroup?.id === group.id ? 'selected' : ''}`} onClick={() => { setActiveGroup(group.id); setGroupView('thread'); }}>
                <Avatar profile={{ display_name: group.name, avatar_path: group.avatar_path }}/>
                <span className="group-row-text"><strong>{group.name}</strong><small>{last ? `${last.author_id === userId ? t('you') : display(author)}: ${snip(last.body || '', 40)}` : t('noGroupPostsShort')}</small></span>
                {last && <small className="group-row-time">{when(last.created_at)}</small>}
              </button>; })}
          </div>
        </aside>
        <section className="group-thread panel" aria-label={t('groupPosts')}>
          {!currentGroup ? <div className="empty-message"><UsersRound size={28}/><p>{t('noGroups')}</p></div> : <>
            <div className="group-thread-head">
              <button type="button" className="icon-button group-back" aria-label={t('back')} title={t('back')} onClick={() => setGroupView('list')}><ArrowLeft size={19}/></button>
              <button type="button" className="group-head-info" onClick={() => setShowGroupInfo(true)} aria-label={t('groupInfo')}>
                <Avatar profile={{ display_name: currentGroup.name, avatar_path: currentGroup.avatar_path }}/>
                <span><strong>{currentGroup.name}</strong><small>{t('memberCount', { n: currentGroupMembers.length })}</small></span>
              </button>
              <button type="button" className="icon-button" aria-label={t('groupInfo')} title={t('groupInfo')} onClick={() => setShowGroupInfo(true)}><Info size={19}/></button>
            </div>
            <div className="message-list group-thread-list" ref={threadRef} aria-live="polite">
              {groupHistory.id === currentGroupId && groupHistory.hasMore && <button type="button" className="secondary" disabled={groupHistory.loading} onClick={() => fetchGroupHistory(currentGroupId, true)}>{t('loadOlderGroupPosts')}</button>}
              {groupPosts.length === 0 && !groupHistory.loading && <div className="empty-message">{t('noGroupPosts')}</div>}
              {groupPosts.map(post => { const mine = post.author_id === userId; const author = profileMap.get(post.author_id);
                return <div key={post.id} className={`message-row ${mine ? 'mine' : ''}`} id={`post-${post.id}`}>
                  {!mine && <small className="group-sender"><Avatar profile={author}/> {display(author)}</small>}
                  <div className={`message ${mine ? 'mine' : ''}`}><p>{renderMessageBody(post.body)}</p>{postImagePaths(post).length > 0 && <div className="group-bubble-images">{postImagePaths(post).map(img => <img key={img} src={publicUrl(POST_IMAGE_BUCKET, img)} alt={t('postImageAlt')}/>)}</div>}
                    <small>{when(post.created_at)}{post.edited_at && ` · ${t('edited')}`}</small></div>
                  <div className="group-bubble-actions">
                    <button type="button" className={`icon-button ${savedPostIds.includes(post.id) ? 'active' : ''}`} aria-label={savedPostIds.includes(post.id) ? t('unsavePost') : t('savePost')} title={savedPostIds.includes(post.id) ? t('unsavePost') : t('savePost')} disabled={busy !== ''} onClick={() => toggleSavedPost(post)}><Bookmark size={13} fill={savedPostIds.includes(post.id) ? 'currentColor' : 'none'}/></button>
                    {mine
                    ? <button type="button" className="icon-button" aria-label={t('deletePost')} title={t('deletePost')} disabled={busy !== ''} onClick={() => askConfirm(t('confirmDelete'), t('deletePost'), () => deletePost(post))}><Trash2 size={13}/></button>
                    : <button type="button" className="icon-button" aria-label={t('reportPost')} title={t('reportPost')} onClick={() => setReportTarget({ type: 'post', id: post.id })}><Flag size={13}/></button>}</div>
                </div>; })}
            </div>
            <form className="message-form" onSubmit={postToBoard}>
              <input aria-label={t('groupBoardPlaceholder', { name: currentGroup.name })} placeholder={t('groupBoardPlaceholder', { name: currentGroup.name })} maxLength={MAX_POST} value={boardText} onChange={e => setBoardText(e.target.value)}/>
              <button className="primary" disabled={busy !== '' || !boardText.trim()} aria-label={t('post')}><Send size={17}/></button>
            </form>
          </>}
        </section>
        {showGroupInfo && currentGroup && <div className="modal-backdrop" onClick={() => { setShowGroupInfo(false); setGroupEditName(null); }}>
          <section className="modal panel group-info" role="dialog" aria-modal="true" aria-label={t('groupInfo')} onClick={e => e.stopPropagation()}>
            <div className="group-info-head"><h2>{t('groupInfo')}</h2><button type="button" className="icon-button" aria-label={t('cancel')} onClick={() => { setShowGroupInfo(false); setGroupEditName(null); }}><X size={18}/></button></div>
            {groupEditName !== null && currentGroup.owner_id === userId
              ? <form className="group-rename" onSubmit={renameGroup}><input aria-label={t('groupName')} maxLength={80} value={groupEditName} onChange={e => setGroupEditName(e.target.value)} autoFocus/><button className="primary" disabled={busy !== '' || !groupEditName.trim()}>{t('saveProfile')}</button><button type="button" className="secondary" onClick={() => setGroupEditName(null)}>{t('cancel')}</button></form>
              : <div className="group-title"><div className={`avatar-wrap ${busy === 'group-photo' ? 'uploading' : ''}`}><Avatar profile={{ display_name: currentGroup.name, avatar_path: currentGroup.avatar_path }}/>{currentGroup.owner_id === userId && <button type="button" className="avatar-edit group-avatar-edit" disabled={busy !== ''} onClick={() => groupAvatarInput.current?.click()} aria-label={currentGroup.avatar_path ? t('changePhoto') : t('addPhoto')} title={currentGroup.avatar_path ? t('changePhoto') : t('addPhoto')}><Camera size={14}/></button>}</div><h2>{currentGroup.name}</h2>{currentGroup.owner_id === userId && <button type="button" className="icon-button group-edit-btn" onClick={() => setGroupEditName(currentGroup.name)} aria-label={t('editGroup')} title={t('editGroup')}><Pencil size={14}/></button>}</div>}
            <p className="muted">{t('groupPostsHint')}</p>
            <h3>{t('groupMembers')}</h3>
            <div className="group-member-list">{currentGroupMembers.map(member => { const person = profileMap.get(member.user_id); return <div className="group-member" key={member.user_id}><Avatar profile={person}/><span><strong>{display(person)}</strong><small>@{person?.handle || 'member'} · {t('joinedGroup', { date: when(member.joined_at) })}</small></span>{currentGroup.owner_id === userId && member.user_id !== userId && <button type="button" className="secondary" disabled={busy !== ''} onClick={() => askConfirm(t('confirmRemoveGroupMember', { name: display(person) }), t('removeMember'), () => changeGroupMember(currentGroup.id, member.user_id, true))}>{t('removeMember')}</button>}</div>; })}</div>
            {currentGroup.owner_id === userId && <div className="group-invite"><label>{t('addMember')}<input value={memberQuery} onChange={e => setMemberQuery(e.target.value)} placeholder={t('searchPeople')}/></label>{memberQuery.trim() && <div className="audience-results">{memberMatches.filter(person => !currentGroupMembers.some(member => member.user_id === person.id)).map(person => <button type="button" key={person.id} disabled={busy !== ''} onClick={() => changeGroupMember(currentGroup.id, person.id)}><Avatar profile={person}/><span>{display(person)} <small>@{person.handle}</small></span><UserPlus size={16}/></button>)}</div>}</div>}
          </section>
        </div>}
      </div>}
      {tab === 'messages' && <>
        {chatKeyLoading && <div className="empty panel">{t('loadingPrivateChat')}</div>}
        {!chatKeyLoading && !chatIdentity && <div className="empty panel">{t('chatUnavailable')}</div>}
        {!chatKeyLoading && chatIdentity?.status === 'new' && <div className="panel chat-setup"><Shield size={28}/><h2>{t('enablePrivateChat')}</h2><p>{t('enablePrivateChatNote')}</p><button className="primary" disabled={busy !== ''} onClick={enableChat}>{t('createChatKey')}</button></div>}
        {!chatKeyLoading && chatIdentity?.status === 'restore' && <div className="panel chat-setup"><Shield size={28}/><h2>{t('restorePrivateChat')}</h2><p>{t('restorePrivateChatNote')}</p><form onSubmit={restoreChat} className="stack-form"><label>{t('recoveryCode')}<input required value={recoveryInput} onChange={e => setRecoveryInput(e.target.value)} autoComplete="off"/></label><button className="primary" disabled={busy !== ''}>{t('restoreChat')}</button></form><div className="reset-chat"><p className="muted">{t('lostRecoveryNote')}</p><button className="secondary" disabled={busy !== ''} onClick={resetChat}>{t('resetChatKey')}</button></div></div>}
        {!chatKeyLoading && chatIdentity?.status === 'ready' && <>
          {recoveryCode && <div className="panel recovery-notice" role="status"><h2>{t('saveRecoveryCode')}</h2><p>{t('saveRecoveryNote')}</p><code>{recoveryCode}</code><button className="secondary" onClick={async () => { try { await acknowledgeRecoveryCode(userId); setRecoveryCode(''); } catch (err) { setError(err.message || t('errAction')); } }}>{t('savedRecoveryCode')}</button></div>}
          <div className="chat-security-note"><Shield size={17}/><span>{t('chatSecurityNote')}</span></div>
          <div className="messages-layout"><div className="contact-list panel"><h2>{t('newConversation')}</h2><p className="muted">{t('chooseMember')}</p>{contacts.map(p => <button key={p.id} className={`contact ${recipient === p.id ? 'selected' : ''}`} onClick={() => { messageRequest.current += 1; setMessages([]); setRecipient(p.id); }}><Avatar profile={p}/><span><strong>{display(p)}</strong><small>@{p.handle}</small></span>{unreadBySender[p.id] > 0 && <span className="badge" aria-label={t('unreadCount', { n: unreadBySender[p.id] })}>{badgeText(unreadBySender[p.id])}</span>}</button>)}{others.length === 0 && <p className="muted">{t('noMembers')}</p>}</div><section className="conversation panel" aria-label={t('conversation')}>{recipient ? <><div className="conversation-header"><PersonLink {...linkProps(recipient)} className="post-person"><Avatar profile={profileMap.get(recipient)}/><strong>{display(profileMap.get(recipient))}</strong></PersonLink><button className="secondary block-button" disabled={busy !== ''} onClick={toggleBlock}>{blockedIds.includes(recipient) ? t('unblock') : t('block')}</button><button className="icon-button" aria-label={t('refreshMessages')} onClick={loadMessages}><RefreshCw size={17}/></button></div><div className="key-fingerprints"><small>{t('yourChatKey')}: <code>{chatIdentity.fingerprint}</code></small><small>{t('contactChatKey')}: {recipientFingerprint ? <code>{recipientFingerprint}</code> : t('contactKeyMissing')}</small>{recipientFingerprint && verifiedRecipientFingerprint !== recipientFingerprint && <div className="verify-key"><p>{t('compareContactKey')}</p><button className="secondary" onClick={verifyRecipientKey}>{t('verifiedContactKey')}</button></div>}{recipientFingerprint && verifiedRecipientFingerprint === recipientFingerprint && <small className="verified-key">{t('contactKeyVerified')}</small>}</div><div className="message-list" aria-live="polite">{messages.length === 0 && <div className="empty-message">{t('noMessages')}</div>}{messages.map((m, i) => <div key={m.id} className={`message-row ${m.sender_id === userId ? 'mine' : ''}`}><div className={`message ${m.sender_id === userId ? 'mine' : ''} ${m.failed ? 'message-failed' : ''}`}><p>{m.failed ? m.text : renderMessageBody(m.text)}</p>{m.legacy && <small>{t('legacyMessage')}</small>}<small>{when(m.created_at)}</small></div>{i === lastMineIndex && 'read_at' in m && <span className={`message-status ${m.read_at ? 'seen' : ''}`}>{m.read_at ? <><CheckCheck size={14}/> {t('seen')} · {new Date(m.read_at).toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US', { hour: 'numeric', minute: '2-digit' })}</> : <><Check size={14}/> {t('sent')}</>}</span>}</div>)}</div><form className="message-form" onSubmit={sendMessage}><input aria-label={t('writeMessage')} placeholder={!recipientKey ? t('contactKeyMissing') : verifiedRecipientFingerprint !== recipientFingerprint ? t('verifyContactKeyFirst') : t('writeMessage')} maxLength={MAX_MESSAGE} value={messageText} onChange={e => setMessageText(e.target.value)} disabled={!recipientKey || verifiedRecipientFingerprint !== recipientFingerprint || blockedIds.includes(recipient)}/><button className="primary" disabled={busy !== '' || !messageText.trim() || !recipientKey || verifiedRecipientFingerprint !== recipientFingerprint || blockedIds.includes(recipient)} aria-label={t('sendMessage')}><Send size={17}/></button></form></> : <div className="empty-message"><Mail size={28}/><p>{t('selectSomeone')}</p></div>}</section></div>
        </>}
      </>}
      {tab === 'profile' && renderProfile()}
      {tab === 'post' && <div className="single-post">
        <button type="button" className="back-button" onClick={() => setTab('feed')}><ArrowLeft size={17}/> {t('backHome')}</button>
        {focusPost.loading && !focusPost.post ? <div className="empty panel">{t('loading')}</div> : focusPost.post ? renderPost(focusPost.post) : <div className="empty panel">{t('postNotFound')}</div>}
      </div>}
    </main>
    {flash && <div className="toast" role="status">{flash}</div>}
    {shareTarget && <div className="modal-backdrop" onClick={() => { setShareTarget(null); setShareQuery(''); }}>
      <div className="modal panel share-modal" role="dialog" aria-modal="true" aria-label={t('sendInMessage')} onClick={e => e.stopPropagation()}>
        <h2>{t('sendInMessage')}</h2>
        <label className="search-box"><Search size={17}/><input autoFocus value={shareQuery} onChange={e => setShareQuery(e.target.value)} placeholder={t('searchPeople')} aria-label={t('searchPeople')}/></label>
        <div className="share-list">
          {shareCandidates.length === 0 && <p className="muted">{t('noMatch')}</p>}
          {shareCandidates.map(p => <button key={p.id} type="button" className="contact" onClick={() => sendShare(p)}><Avatar profile={p}/><span><strong>{display(p)}</strong><small>@{p.handle}</small></span><Send size={16} className="share-send"/></button>)}
        </div>
        <div className="form-actions-inline"><button className="secondary" onClick={() => { setShareTarget(null); setShareQuery(''); }}>{t('cancel')}</button></div>
      </div>
    </div>}
    {reportTarget && <ReportDialog t={t} busy={busy !== ''} onCancel={() => setReportTarget(null)} onSubmit={submitReport}/>}
    {confirmBox && <ConfirmDialog message={confirmBox.message} confirmLabel={confirmBox.confirmLabel} cancelLabel={t('cancel')} onCancel={() => setConfirmBox(null)} onConfirm={() => { const run = confirmBox.onConfirm; setConfirmBox(null); run(); }}/>}
    {lightbox && <Lightbox
      t={t}
      urls={lightbox.paths.map(p => publicUrl(POST_IMAGE_BUCKET, p))}
      index={lightbox.index}
      onIndex={index => setLightbox(prev => ({ ...prev, index }))}
      onClose={() => setLightbox(null)}
      post={lightbox.post}
      canReport={lightbox.post.author_id !== userId}
      likeCount={counts.find(item => item.post_id === lightbox.post.id)?.like_count ?? 0}
      commentCount={counts.find(item => item.post_id === lightbox.post.id)?.comment_count ?? 0}
      liked={likes.some(item => item.post_id === lightbox.post.id)}
      saved={savedPostIds.includes(lightbox.post.id)}
      busy={busy !== ''}
      onLike={() => mutate('like', () => likes.some(item => item.post_id === lightbox.post.id)
        ? supabase.from('likes').delete().eq('post_id', lightbox.post.id).eq('user_id', userId)
        : supabase.from('likes').insert({ post_id: lightbox.post.id, user_id: userId }))}
      onComment={() => { const id = lightbox.post.id; setLightbox(null); loadComments(id); setOpenComments(prev => ({ ...prev, [id]: true })); }}
      onSave={() => toggleSavedPost(lightbox.post)}
      onShare={() => { const post = lightbox.post; setLightbox(null); setShareTarget(post); setShareQuery(''); }}
      onCopyLink={() => copyPostLink(lightbox.post)}
      onReport={() => { const id = lightbox.post.id; setLightbox(null); setReportTarget({ type: 'post', id }); }}
    />}
  </div>;
}

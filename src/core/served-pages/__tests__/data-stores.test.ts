import { describe, expect, it } from 'vitest';
import { dataStoreOf, dataStoresOf, inDataStore, storeHeldBy, type StoreHost } from '../data-stores';

const WINDOWS: StoreHost = {
  platform: 'win32',
  home: 'C:\\Users\\me',
  env: {
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
    SystemRoot: 'C:\\WINDOWS',
    TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
  },
  drives: [],
};

const MAC: StoreHost = { platform: 'darwin', home: '/Users/me', env: {}, drives: [] };
const LINUX: StoreHost = { platform: 'linux', home: '/home/me', env: { XDG_CONFIG_HOME: '/home/me/conf', XDG_DATA_HOME: '/data/me', XDG_CACHE_HOME: 'relative/cache' }, drives: [] };
// a WSL distro with drive C: at /mnt/c and drive D: at a mount point of the user's own
const WSL: StoreHost = { platform: 'linux', home: '/home/me', env: {}, drives: [{ mountPoint: '/mnt/c', prefix: [] }, { mountPoint: '/media/d drive', prefix: [] }] };

const denied = (host: StoreHost, file: string): boolean => inDataStore(file, dataStoresOf(host));

describe('inDataStore', () => {
  it('holds a Windows file in a per-user or machine data store, its folder named in any case', () => {
    for (const file of [
      'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\cookies.sqlite',
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies',
      'C:\\Users\\me\\AppData\\LocalLow\\app\\token.json',
      'c:\\users\\ME\\appdata\\roaming\\x.json',
      'C:/Users/me/APPDATA/Local/x.json',
      'C:\\ProgramData\\app\\secret.json',
      'C:\\Windows\\System32\\config\\SAM',
    ]) expect(denied(WINDOWS, file), file).toBe(true);
  });

  it('takes a Windows store from env named in any case, and AppData under the home folder without env', () => {
    expect(denied({ platform: 'win32', home: 'D:\\Profiles\\me', env: { appdata: 'E:\\Roaming' }, drives: [] }, 'E:\\Roaming\\app\\x.json')).toBe(true);
    expect(denied({ platform: 'win32', home: 'D:\\Profiles\\me', env: {}, drives: [] }, 'D:\\Profiles\\me\\AppData\\LocalLow\\x.json')).toBe(true);
    expect(denied({ platform: 'win32', home: 'D:\\Profiles\\me', env: { SYSTEMROOT: 'C:\\Windows' }, drives: [] }, 'C:\\Windows\\win.ini')).toBe(true);
  });

  it('holds a macOS file under ~/Library in any case, and a device', () => {
    for (const file of ['/Users/me/Library/Keychains/login.keychain-db', '/Users/me/library/Application Support/Google/Chrome/Default/Cookies', '/dev/fd/3']) expect(denied(MAC, file), file).toBe(true);
  });

  it('holds a Linux pseudo or runtime file system and an XDG store, compared case-sensitively', () => {
    for (const file of ['/proc/self/environ', '/sys/kernel/x', '/dev/shm/x', '/run/secrets/token', '/home/me/conf/gh/hosts.yml', '/data/me/keyrings/login.keyring']) expect(denied(LINUX, file), file).toBe(true);
    expect(denied(LINUX, '/PROC/self/environ')).toBe(false);
    expect(denied(LINUX, '/home/me/Conf/x')).toBe(false);
  });

  it('ignores an XDG variable that is not an absolute path', () => {
    expect(denied(LINUX, '/home/me/relative/cache/x')).toBe(false);
  });

  it('leaves ordinary content: shared assets, a sibling repo, the temp folder and pnpm\'s default store', () => {
    for (const file of [
      'C:\\Users\\me\\shared\\assets\\logo.png',
      'C:\\Users\\me\\src\\sibling\\index.html',
      'C:\\Users\\me\\AppData\\Local\\Temp\\build\\page.html',
      'C:\\Users\\me\\AppData\\Local\\pnpm\\store\\v10\\links\\x\\node_modules\\x\\index.js',
      'C:\\Users\\me\\AppDataBackup\\x.html',
      'C:\\ProgramDataFiles\\x.html',
    ]) expect(denied(WINDOWS, file), file).toBe(false);
    expect(denied(MAC, '/Users/me/Library/pnpm/store/v10/files/00/abc')).toBe(false);
    expect(denied(MAC, '/Users/me/shared/assets/logo.png')).toBe(false);
    expect(denied(LINUX, '/data/me/pnpm/store/v10/files/00/abc')).toBe(false);
    expect(denied(LINUX, '/home/me/shared/assets/logo.png')).toBe(false);
    expect(denied(LINUX, '/runner/x.html')).toBe(false);
  });

  it('leaves cloud-synced folders under macOS\'s ~/Library and Linux\'s removable and GVFS mounts under /run', () => {
    for (const file of ['/Users/me/Library/CloudStorage/Dropbox/team/assets/logo.png', '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/site/page.html']) expect(denied(MAC, file), file).toBe(false);
    expect(denied(MAC, '/Users/me/Library/Mobile Documents/com~apple~Notes/x.db')).toBe(true);
    const linux: StoreHost = { ...LINUX, env: { ...LINUX.env, XDG_RUNTIME_DIR: '/run/user/1000' } };
    for (const file of ['/run/media/me/USB/assets/logo.png', '/run/user/1000/gvfs/smb-share:server=nas,share=team/page.html']) expect(denied(linux, file), file).toBe(false);
    for (const file of ['/run/user/1000/containers/auth.json', '/run/secrets/token']) expect(denied(linux, file), file).toBe(true);
  });

  it('drops a store that is a file system root, and an XDG store that is the home folder or holds it', () => {
    expect(denied({ ...LINUX, env: { XDG_DATA_HOME: '/home/me', XDG_CACHE_HOME: '/', XDG_STATE_HOME: '/home' } }, '/home/me/shared/assets/logo.png')).toBe(false);
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, ProgramData: 'C:\\' } }, 'C:\\Users\\me\\shared\\logo.png')).toBe(false);
    expect(denied({ ...LINUX, env: { XDG_DATA_HOME: '/home/me' } }, '/proc/self/environ')).toBe(true);
  });

  it('keeps any other store that holds the home folder, as a LocalSystem service\'s home lies in the Windows folder', () => {
    const localSystem: StoreHost = { platform: 'win32', home: 'D:\\WinNT\\system32\\config\\systemprofile', env: { SystemRoot: 'D:\\WinNT' }, drives: [] };
    expect(denied(localSystem, 'D:\\WinNT\\win.ini')).toBe(true);
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, APPDATA: 'c:\\users\\ME' } }, 'C:\\Users\\me\\src\\page.html')).toBe(true);
    expect(denied({ ...LINUX, home: '/run/service' }, '/run/secrets/token')).toBe(true);
  });

  it('reads a Windows env value through its \\\\?\\ and \\\\?\\UNC\\ namespace prefixes', () => {
    const host: StoreHost = { platform: 'win32', home: 'C:\\Users\\me', env: { ProgramData: '\\\\?\\D:\\Machine', APPDATA: '\\\\?\\UNC\\srv\\share\\roaming' }, drives: [] };
    expect(denied(host, 'D:\\Machine\\app\\x.json')).toBe(true);
    expect(denied(host, '\\\\srv\\share\\roaming\\app\\x.json')).toBe(true);
    expect(denied(host, '\\\\srv\\share\\other\\x.json')).toBe(false);
  });

  it('takes pnpm\'s store from PNPM_HOME, and never lets an ordinary folder that is a whole store open it', () => {
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, PNPM_HOME: 'C:\\Users\\me\\AppData\\Roaming\\pnpm' } }, 'C:\\Users\\me\\AppData\\Roaming\\pnpm\\store\\v10\\x.js')).toBe(false);
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, TEMP: 'C:\\Users\\me\\AppData\\Local' } }, 'C:\\Users\\me\\AppData\\Local\\Google\\x')).toBe(true);
  });
});

describe('a Windows drive mounted in WSL', () => {
  it('holds Windows, ProgramData and each profile\'s AppData, named in any case, as drvfs looks names up', () => {
    for (const file of [
      '/mnt/c/Windows',
      '/mnt/c/WINDOWS/System32/config/SAM',
      '/mnt/c/windows/win.ini',
      '/mnt/c/ProgramData/app/secret.json',
      '/mnt/c/programdata/x',
      '/mnt/c/Users/me/AppData',
      '/mnt/c/users/me/appdata/roaming/Damocles/x.json',
      '/mnt/c/Users/other/AppData/Local/Google/Chrome/User Data/Default/Cookies',
      '/media/d drive/Windows/x',
    ]) expect(denied(WSL, file), file).toBe(true);
  });

  it('counts an 8.3 alias where a store name is compared, and never lets one in an ordinary suffix open the store', () => {
    for (const file of [
      '/mnt/c/PROGRA~3/app/secret.json',
      '/mnt/c/WINDOW~1/x',
      '/mnt/c/USERS~1/me/AppData/x',
      '/mnt/c/Users/me/APPDAT~1/Roaming/x',
      '/mnt/c/Users/me/AppData/Local/TEMP~1/x',
      '/mnt/c/Users/me/AppData/LOCAL~1/Temp/x',
      '/mnt/c/Users/me/AppData/Local/pnpm/STORE~1/x',
    ]) expect(denied(WSL, file), file).toBe(true);
  });

  it('leaves the profiles\' temp folders, pnpm stores and every other folder of the drive', () => {
    for (const file of [
      '/mnt/c',
      '/mnt/c/Users/me',
      '/mnt/c/Users/me/src/site/index.html',
      '/mnt/c/Users/me/AppData/Local/Temp/build/page.html',
      '/mnt/c/users/me/appdata/local/temp/x',
      '/mnt/c/Users/me/AppData/Local/pnpm/store/v10/x.js',
      '/mnt/c/Users/me/AppDataBackup/x',
      '/mnt/c/Windows.old/x',
      '/mnt/c/work/Windows/x',
      '/mnt/cc/Windows/x',
      '/MNT/C/Windows/x',
      '/home/me/Windows/x',
    ]) expect(denied(WSL, file), file).toBe(false);
  });

  it('names the store as spelled, and takes drives on Linux only', () => {
    expect(dataStoreOf('/mnt/c/users/me/APPDATA/Roaming/x', dataStoresOf(WSL))).toBe('/mnt/c/users/me/APPDATA');
    expect(dataStoreOf('/mnt/c/PROGRA~3/x', dataStoresOf(WSL))).toBe('/mnt/c/PROGRA~3');
    expect(dataStoreOf('/proc/self/environ', dataStoresOf(WSL))).toBe('/proc');
    expect(dataStoresOf({ ...MAC, drives: WSL.drives }).drives).toEqual([]);
    expect(denied({ ...MAC, drives: WSL.drives }, '/mnt/c/Windows/x')).toBe(false);
  });
});

describe('every drive of a Windows host', () => {
  const stores = dataStoresOf(WINDOWS);

  it('holds Windows and ProgramData at any drive\'s root and any AppData, in any case', () => {
    for (const file of [
      'C:\\Users\\Other\\AppData\\Roaming\\x',
      'D:\\Windows\\System32',
      'd:\\windows',
      'D:\\ProgramData\\x',
      'D:\\Profiles\\me\\AppData\\Local\\y',
      'E:\\data\\AppData\\z',
      'E:\\data\\appdata',
      'C:\\Users\\me\\AppData\\Local\\TEMP~1\\x',
      'C:\\Users\\me\\AppData\\Local\\pnpm\\STORE~1\\x',
      'E:\\data\\AppData\\Local\\Temp\\build\\AppData\\x',
    ]) expect(denied(WINDOWS, file), file).toBe(true);
    expect(dataStoreOf('E:\\data\\AppData\\z\\x', stores)).toBe('E:\\data\\AppData');
    expect(dataStoreOf('d:/windows/x', stores)).toBe('d:\\windows');
  });

  it('leaves each AppData\'s temp folder and pnpm store, named in full, and folders that only start with a store\'s name', () => {
    for (const file of [
      'C:\\Users\\me\\AppData\\Local\\Temp\\x',
      'C:\\Users\\me\\AppData\\Local\\pnpm\\store\\x',
      'E:\\data\\AppData\\Local\\Temp\\x',
      'C:\\Users\\Other\\AppData\\Local\\pnpm\\store\\v10\\x.js',
      'C:\\Windows.old\\x',
      'D:\\WindowsApps\\x',
      'D:\\data\\AppDataBackup\\x',
      'D:\\data\\Windows\\x',
      'D:\\data\\ProgramData\\x',
      'D:\\',
    ]) expect(denied(WINDOWS, file), file).toBe(false);
  });

  it('compares a native drive\'s names in full, as its paths are judged on their realpath, and counts an 8.3 name through WSL', () => {
    for (const file of ['C:\\Users\\ME~1\\AppData\\Local\\Temp\\x', 'D:\\WINDOW~1\\x', 'D:\\PROGRA~3\\x', 'D:\\x\\APPDAT~1\\y']) expect(denied(WINDOWS, file), file).toBe(false);
    expect(storeHeldBy('D:\\USERS~1\\x', stores)).toBeUndefined();
    for (const file of ['\\\\wsl$\\Ubuntu\\mnt\\d\\WINDOW~1\\x', '\\\\wsl$\\Ubuntu\\mnt\\d\\PROGRA~3\\x', '\\\\wsl$\\Ubuntu\\mnt\\d\\x\\APPDAT~1\\y']) expect(denied(WINDOWS, file), file).toBe(true);
    expect(storeHeldBy('\\\\wsl$\\Ubuntu\\mnt\\d\\USERS~1\\x', stores)).toBe('\\\\wsl$\\Ubuntu\\mnt\\d\\USERS~1\\x\\AppData');
  });

  it('keeps an env carve-out inside an AppData, and the temp folder of a TEMP spelled with an 8.3 name before it resolves', () => {
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, TEMP: 'C:\\Users\\me\\AppData\\Local\\BuildTemp' } }, 'C:\\Users\\me\\AppData\\Local\\BuildTemp\\x')).toBe(false);
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, PNPM_HOME: 'C:\\Users\\me\\AppData\\Roaming\\pnpm' } }, 'C:\\Users\\me\\AppData\\Roaming\\pnpm\\store\\x')).toBe(false);
    expect(denied({ ...WINDOWS, env: { ...WINDOWS.env, TEMP: 'C:\\Users\\ME~1\\AppData\\Local\\Temp' } }, 'C:\\Users\\me\\AppData\\Local\\Temp\\x')).toBe(false);
  });

  it('lets an env store\'s own AppData temp folder and pnpm store out of it, whatever home and TEMP say, and no other store\'s', () => {
    const service: StoreHost = { platform: 'win32', home: 'D:\\Profiles\\svc', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TEMP: 'C:\\Users\\ME~1\\AppData\\Local\\Temp', SystemRoot: 'C:\\Windows' }, drives: [] };
    expect(denied(service, 'C:\\Users\\me\\AppData\\Local\\Temp\\x')).toBe(false);
    expect(denied(service, 'C:\\Users\\me\\AppData\\Local\\pnpm\\store\\x')).toBe(false);
    expect(denied(service, 'C:\\Users\\me\\AppData\\Local\\TEMP~1\\x')).toBe(true);
    expect(denied(service, 'C:\\Users\\me\\AppData\\Local\\Google\\Temp\\x')).toBe(true);
    expect(denied(service, 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Temp\\x')).toBe(true);
  });

  it('judges a path into a WSL distro\'s drive mount as that drive\'s path, in any spelling of WSL\'s host', () => {
    for (const file of [
      '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\x',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Windows\\x',
      '//WSL.LOCALHOST/Ubuntu/mnt/d/ProgramData/x',
      '\\\\wsl$/Ubuntu\\mnt/e\\data\\AppData\\x',
    ]) expect(denied(WINDOWS, file), file).toBe(true);
    expect(dataStoreOf('\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\x', stores)).toBe('C:\\Users\\me\\AppData\\Roaming');
    expect(dataStoreOf('\\\\wsl$\\Ubuntu\\mnt\\d\\Windows\\x', stores)).toBe('D:\\Windows');
    for (const file of [
      '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Local\\Temp\\x',
      '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\src\\x',
      '\\\\wsl$\\Ubuntu\\mnt\\cd\\Windows\\x',
      '\\\\wsl$\\Ubuntu\\MNT\\c\\Windows\\x',
      '\\\\wsl$\\Ubuntu\\home\\me\\Windows\\x',
      '\\\\server\\share\\mnt\\c\\Windows\\x',
    ]) expect(denied(WINDOWS, file), file).toBe(false);
  });

  it('holds a profile\'s AppData at a drive\'s Users folder or a profile, and WSL\'s drives at \\\\wsl$\\<distro>\\mnt', () => {
    expect(storeHeldBy('D:\\Users', stores)).toBe('D:\\Users\\<user>\\AppData');
    expect(storeHeldBy('d:\\USERS\\x', stores)).toBe('d:\\USERS\\x\\AppData');
    expect(storeHeldBy('D:\\Users\\x\\src', stores)).toBeUndefined();
    expect(storeHeldBy('D:\\Profiles\\me', stores)).toBeUndefined();
    expect(storeHeldBy('\\\\wsl$\\Ubuntu\\mnt', stores)).toBe('\\\\wsl$\\Ubuntu\\mnt\\<drive>\\Windows');
    expect(storeHeldBy('\\\\wsl$\\Ubuntu\\mnt\\d\\Users', stores)).toBe('\\\\wsl$\\Ubuntu\\mnt\\d\\Users\\<user>\\AppData');
    expect(storeHeldBy('\\\\wsl$\\Ubuntu\\mnt\\c\\Users', stores)).toBe('C:\\Users\\me\\AppData\\Roaming');
    expect(storeHeldBy('\\\\wsl$\\Ubuntu\\home', stores)).toBeUndefined();
  });
});

describe('a WSL drive mount of a drive\'s subfolder', () => {
  const host = (...drives: StoreHost['drives']): StoreHost => ({ ...WSL, drives: [WSL.drives[0]!, ...drives] });

  it('judges the mount\'s files by the drive folder it shows, so Docker\'s resources mount holds no Windows folder', () => {
    const stores = dataStoresOf(host({ mountPoint: '/Docker/host', prefix: ['Program Files', 'Docker', 'Docker', 'resources'] }));
    expect(storeHeldBy('/Docker', stores)).toBeUndefined();
    expect(storeHeldBy('/Docker/host', stores)).toBeUndefined();
    expect(dataStoreOf('/Docker/host/Windows/x', stores)).toBeUndefined();
    expect(dataStoreOf('/Docker/host/AppData/x', stores)).toBe('/Docker/host/AppData');
  });

  it('names a bound AppData\'s mount point as its store, and a folder above it as holding it', () => {
    const stores = dataStoresOf(host({ mountPoint: '/srv/ad', prefix: ['Users', 'me', 'AppData'] }));
    expect(dataStoreOf('/srv/ad/Roaming/x', stores)).toBe('/srv/ad');
    expect(dataStoreOf('/srv/ad', stores)).toBe('/srv/ad');
    expect(dataStoreOf('/srv/ad/Local/Temp/x', stores)).toBeUndefined();
    expect(storeHeldBy('/srv', stores)).toBe('/srv/ad');
  });

  it('leaves a bound temp folder ordinary, and holds a bound Users folder\'s profiles\' AppData', () => {
    const temp = dataStoresOf(host({ mountPoint: '/t', prefix: ['Users', 'me', 'AppData', 'Local', 'Temp'] }));
    expect(dataStoreOf('/t/x', temp)).toBeUndefined();
    expect(storeHeldBy('/t', temp)).toBeUndefined();
    const users = dataStoresOf(host({ mountPoint: '/u', prefix: ['Users'] }));
    expect(storeHeldBy('/u', users)).toBe('/u/<user>/AppData');
    expect(storeHeldBy('/u/me', users)).toBe('/u/me/AppData');
    expect(dataStoreOf('/u/me/AppData/x', users)).toBe('/u/me/AppData');
  });

  it('holds any AppData of a drive, at any depth', () => {
    expect(dataStoreOf('/mnt/c/data/AppData/z', dataStoresOf(WSL))).toBe('/mnt/c/data/AppData');
  });
});

describe('storeHeldBy', () => {
  it('names a store the folder is or holds', () => {
    expect(storeHeldBy('C:\\Users', dataStoresOf(WINDOWS))).toBe('C:\\Users\\me\\AppData\\Roaming');
    expect(storeHeldBy('c:\\programdata', dataStoresOf(WINDOWS))).toBe('C:\\ProgramData');
    expect(storeHeldBy('/home/me/conf', dataStoresOf(LINUX))).toBe('/home/me/conf');
    expect(storeHeldBy('C:\\Users\\me\\src', dataStoresOf(WINDOWS))).toBeUndefined();
  });

  it('holds a drive\'s Windows folder at or above its mount point, and a profile\'s AppData at its Users folder or a profile', () => {
    const stores = dataStoresOf(WSL);
    expect(storeHeldBy('/mnt', stores)).toBe('/mnt/c/Windows');
    expect(storeHeldBy('/mnt/c', stores)).toBe('/mnt/c/Windows');
    expect(storeHeldBy('/media/d drive', stores)).toBe('/media/d drive/Windows');
    expect(storeHeldBy('/mnt/c/Users', stores)).toBe('/mnt/c/Users/<user>/AppData');
    expect(storeHeldBy('/mnt/c/users/me', stores)).toBe('/mnt/c/users/me/AppData');
    expect(storeHeldBy('/mnt/c/Users/me/src', stores)).toBeUndefined();
    expect(storeHeldBy('/mnt/c/work', stores)).toBeUndefined();
    expect(storeHeldBy('/home/me/Users/me', stores)).toBeUndefined();
  });
});

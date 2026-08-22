import * as preferences from '../services/preferences.js';
import { readJsonBody, sendJson } from './http.js';

export function settingsRoute() {
  return async (request, response, url) => {
    if (url.pathname !== '/api/settings') return false;
    if (request.method === 'GET') {
      sendJson(response, 200, await preferences.getPreferences());
      return true;
    }
    if (request.method === 'PUT') {
      sendJson(response, 200, await preferences.updatePreferences(await readJsonBody(request)));
      return true;
    }
    return false;
  };
}

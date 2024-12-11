import FormData from 'form-data';
import fs from 'fs';
import {IncomingMessage} from 'http';

export default (
  hookURL: string,
  file: string,
  {username, avatar_url}: {username: string; avatar_url: string},
) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const form = new FormData();

    if (username) {
      form.append('username', username);
    }

    if (avatar_url) {
      form.append('avatar_url', avatar_url);
    }

    form.append('file', fs.createReadStream(file));

    form.submit(hookURL, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

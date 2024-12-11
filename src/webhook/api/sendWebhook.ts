import fetch from 'node-fetch';
import {Response} from 'node-fetch';

export default (hookURL: string, payload: any) =>
  new Promise<Response>((resolve, reject) => {
    fetch(hookURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
      .then(res => resolve(res))
      .catch(err => reject(err));
  });

/**
 * Dynamic variables — `{{$name}}`. Compatible with common Postman names.
 */
const FIRST = ['Aarav', 'Vivaan', 'Ananya', 'Diya', 'Arjun', 'Priya', 'Rahul', 'Sneha', 'Karan', 'Meera', 'Aditya', 'Isha', 'Rohan', 'Kavya', 'Nikhil', 'Riya', 'Manish', 'Pooja', 'Vikram', 'Neha', 'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth'];
const LAST = ['Sharma', 'Verma', 'Singh', 'Patel', 'Gupta', 'Kumar', 'Reddy', 'Nair', 'Iyer', 'Das', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor'];
const DOMAINS = ['example.com', 'example.org', 'mail.test', 'sample.dev', 'demo.io'];
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat'.split(' ');

function rnd(max: number): number { return Math.floor(Math.random() * max); }
function pick<T>(arr: T[]): T { return arr[rnd(arr.length)]; }

function randomString(len: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[rnd(alphabet.length)];
  return s;
}

export interface DynamicEvalContext {
  args?: string[];
}

/** Evaluate a dynamic variable by name. Returns undefined if unknown. */
export function evalDynamic(name: string): string | undefined {
  const n = name.trim();
  switch (n) {
    case '$guid':
    case '$uuid':
    case '$randomUUID': {
      const c = (globalThis as { crypto?: Crypto }).crypto;
      return c?.randomUUID ? c.randomUUID() : `${Date.now()}-${randomString(8)}-${randomString(4)}-${randomString(12)}`;
    }
    case '$timestamp': return Math.floor(Date.now() / 1000).toString();
    case '$isoTimestamp': return new Date().toISOString();
    case '$date': return new Date().toDateString();
    case '$randomInt': return (rnd(1001)).toString();
    case '$randomNumber': return rnd(1000000).toString();
    case '$randomString': return randomString(12);
    case '$randomAlphanumeric': return randomString(16);
    case '$randomEmail': return `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rnd(100)}@${pick(DOMAINS)}`;
    case '$randomUserName': return `${pick(FIRST).toLowerCase()}${rnd(1000)}`;
    case '$randomFirstName': return pick(FIRST);
    case '$randomLastName': return pick(LAST);
    case '$randomFullName': return `${pick(FIRST)} ${pick(LAST)}`;
    case '$randomName': return `${pick(FIRST)} ${pick(LAST)}`;
    case '$randomIP': case '$randomIpv4': return `${rnd(223) + 1}.${rnd(256)}.${rnd(256)}.${rnd(256)}`;
    case '$randomIpv6': return Array.from({ length: 8 }, () => rnd(65536).toString(16)).join(':');
    case '$randomBoolean': return Math.random() < 0.5 ? 'true' : 'false';
    case '$randomColor': return `#${randomString(6, '0123456789abcdef')}`;
    case '$randomHexColor': return `#${randomString(6, '0123456789abcdef')}`;
    case '$randomMacAddress': return Array.from({ length: 6 }, () => rnd(256).toString(16).padStart(2, '0')).join(':');
    case '$randomPassword': return randomString(20);
    case '$randomLorem': case '$randomLoremSentence': {
      const words = Array.from({ length: 6 + rnd(8) }, () => pick(WORDS));
      return words.join(' ').replace(/^./, (c) => c.toUpperCase()) + '.';
    }
    case '$randomLoremParagraph': {
      const s = Array.from({ length: 4 }, () => evalDynamic('$randomLoremSentence')).join(' ');
      return s;
    }
    case '$randomPhone': return `+${1 + rnd(9)}${randomString(10, '0123456789')}`;
    case '$randomUrl': return `https://${pick(DOMAINS)}/${randomString(8, 'abcdefghijklmnopqrstuvwxyz')}`;
    case '$randomDomainName': return pick(DOMAINS);
    case '$randomCountryCode': return pick(['IN', 'US', 'GB', 'DE', 'FR', 'JP', 'AU', 'BR', 'CA', 'NL']);
    case '$randomCurrencyCode': return pick(['INR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD']);
    case '$randomLatitude': return (Math.random() * 180 - 90).toFixed(6);
    case '$randomLongitude': return (Math.random() * 360 - 180).toFixed(6);
    case '$randomAbbreviation': return randomString(3).toUpperCase();
    case '$randomBankAccount': return randomString(10, '0123456789');
    case '$randomPrice': return (Math.random() * 1000).toFixed(2);
    case '$randomWord': return pick(WORDS);
    case '$randomWords': return Array.from({ length: 3 }, () => pick(WORDS)).join(' ');
    case '$randomCity': return pick(['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Jaipur', 'Chennai', 'Kolkata', 'Hyderabad', 'Lucknow', 'Jaipur']) ;
    case '$randomJobTitle': return `${pick(['Senior', 'Lead', 'Principal', 'Junior'])} ${pick(['Engineer', 'Designer', 'Manager', 'Analyst'])}`;
    default: return undefined;
  }
}

export function isDynamic(name: string): boolean { return name.trim().startsWith('$'); }

export function listDynamic(): string[] {
  return ['$guid', '$uuid', '$timestamp', '$isoTimestamp', '$date', '$randomInt', '$randomNumber', '$randomString', '$randomEmail', '$randomUserName', '$randomFirstName', '$randomLastName', '$randomFullName', '$randomIP', '$randomBoolean', '$randomColor', '$randomPassword', '$randomLorem', '$randomPhone', '$randomUrl', '$randomPrice', '$randomWord'];
}

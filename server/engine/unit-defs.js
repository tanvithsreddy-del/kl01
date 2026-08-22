const DEFINITIONS = [
  { id: 'm', dimension: 'length', factor: '1', aliases: ['m','metre','metres','meter','meters'] },
  { id: 'km', dimension: 'length', factor: '1000', aliases: ['km','kilometre','kilometres','kilometer','kilometers'] },
  { id: 'cm', dimension: 'length', factor: '0.01', aliases: ['cm','centimetre','centimetres','centimeter','centimeters'] },
  { id: 'mm', dimension: 'length', factor: '0.001', aliases: ['mm','millimetre','millimetres','millimeter','millimeters'] },
  { id: 'in', dimension: 'length', factor: '0.0254', aliases: ['in','inch','inches'] },
  { id: 'ft', dimension: 'length', factor: '0.3048', aliases: ['ft','foot','feet'] },
  { id: 'yd', dimension: 'length', factor: '0.9144', aliases: ['yd','yard','yards'] },
  { id: 'mi', dimension: 'length', factor: '1609.344', aliases: ['mi','mile','miles'] },

  { id: 'kg', dimension: 'mass', factor: '1', aliases: ['kg','kilogram','kilograms'] },
  { id: 'g', dimension: 'mass', factor: '0.001', aliases: ['g','gram','grams'] },
  { id: 'mg', dimension: 'mass', factor: '0.000001', aliases: ['mg','milligram','milligrams'] },
  { id: 'lb', dimension: 'mass', factor: '0.45359237', aliases: ['lb','lbs','pound','pounds'] },
  { id: 'oz', dimension: 'mass', factor: '0.028349523125', aliases: ['oz','ounce','ounces'] },

  { id: 's', dimension: 'time', factor: '1', aliases: ['s','sec','secs','second','seconds'] },
  { id: 'min', dimension: 'time', factor: '60', aliases: ['min','mins','minute','minutes'] },
  { id: 'h', dimension: 'time', factor: '3600', aliases: ['h','hr','hrs','hour','hours'] },
  { id: 'day', dimension: 'time', factor: '86400', aliases: ['day','days','d'] },

  { id: 'one', dimension: 'count', factor: '1', aliases: ['one','unit','units'] },
  { id: 'thousand', dimension: 'count', factor: '1000', aliases: ['thousand','thousands','k'] },
  { id: 'lakh', dimension: 'count', factor: '100000', aliases: ['lakh','lakhs','lac','lacs'] },
  { id: 'crore', dimension: 'count', factor: '10000000', aliases: ['crore','crores','cr'] },
  { id: 'million', dimension: 'count', factor: '1000000', aliases: ['million','millions','mn'] },
  { id: 'billion', dimension: 'count', factor: '1000000000', aliases: ['billion','billions','bn'] },

  { id: 'B', dimension: 'data', factor: '1', aliases: ['b','byte','bytes'] },
  { id: 'KB', dimension: 'data', factor: '1000', aliases: ['kb','kilobyte','kilobytes'] },
  { id: 'MB', dimension: 'data', factor: '1000000', aliases: ['mb','megabyte','megabytes'] },
  { id: 'GB', dimension: 'data', factor: '1000000000', aliases: ['gb','gigabyte','gigabytes'] },
  { id: 'KiB', dimension: 'data', factor: '1024', aliases: ['kib','kibibyte','kibibytes'] },
  { id: 'MiB', dimension: 'data', factor: '1048576', aliases: ['mib','mebibyte','mebibytes'] },
  { id: 'GiB', dimension: 'data', factor: '1073741824', aliases: ['gib','gibibyte','gibibytes'] },

  { id: 'm/s', dimension: 'speed', factor: '1', aliases: ['m/s','mps','metre/second','meter/second','metres/second','meters/second'] },
  { id: 'km/h', dimension: 'speed', numerator: '5', denominator: '18', aliases: ['km/h','kph','kmph','kilometres/hour','kilometers/hour'] },
  { id: 'mph', dimension: 'speed', factor: '0.44704', aliases: ['mph','mi/h','miles/hour','mile/hour'] },

  { id: 'C', dimension: 'temperature', affine: 'celsius', aliases: ['c','°c','celsius','centigrade'] },
  { id: 'F', dimension: 'temperature', affine: 'fahrenheit', aliases: ['f','°f','fahrenheit'] },
  { id: 'K', dimension: 'temperature', affine: 'kelvin', aliases: ['kelvin','kelvins'] },
];

const aliasMap = new Map();
const idMap = new Map(DEFINITIONS.map(definition => [definition.id, definition]));
for (const definition of DEFINITIONS) for (const alias of definition.aliases) aliasMap.set(alias.toLocaleLowerCase(), definition);

export function resolveUnit(input) {
  const raw = String(input || '').trim().normalize('NFC').replace(/\s+/g, '');
  if (raw === 'K') return idMap.get('K');
  const key = raw.toLocaleLowerCase();
  return aliasMap.get(key) || null;
}


export function isUnit(input) { return Boolean(resolveUnit(input)); }
export function allUnitAliases() { return [...aliasMap.keys()].sort((a,b) => b.length - a.length); }
export const UNIT_DEFINITIONS = Object.freeze(DEFINITIONS.map(item => Object.freeze({ ...item, aliases: Object.freeze([...item.aliases]) })));

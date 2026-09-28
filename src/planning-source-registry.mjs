const NATIONAL_SOURCE_NAMES = {
  CORKCOCO:'Cork County Council', CORKCITY:'Cork City Council', DUBLINCITY:'Dublin City Council', FINGAL:'Fingal County Council',
  SOUTHDUBLIN:'South Dublin County Council', DLR:'Dun Laoghaire Rathdown County Council', KILDARE:'Kildare County Council',
  GALWAYCOCO:'Galway County Council', GALWAYCITY:'Galway City Council', MEATH:'Meath County Council', WICKLOW:'Wicklow County Council',
  LIMERICK:'Limerick County Council', WATERFORD:'Waterford City and County Council', DONEGAL:'Donegal County Council', WEXFORD:'Wexford County Council',
  TIPPERARY:'Tipperary County Council', KERRY:'Kerry County Council', MAYO:'Mayo County Council', CLARE:'Clare County Council',
  LOUTH:'Louth County Council', LAOIS:'Laois County Council', KILKENNY:'Kilkenny County Council', OFFALY:'Offaly County Council',
  CAVAN:'Cavan County Council', ROSCOMMON:'Roscommon County Council', WESTMEATH:'Westmeath County Council', MONAGHAN:'Monaghan County Council',
  SLIGO:'Sligo County Council', CARLOW:'Carlow County Council', LONGFORD:'Longford County Council', LEITRIM:'Leitrim County Council'
};

const AGILE_AUTHORITIES = {
  CORKCOCO:{ client:'CORKCOCO', tenant:'corkcoco', name:'Cork County Council' },
  CORKCITY:{ client:'CORKCITY', tenant:'corkcity', name:'Cork City Council' },
  DUBLINCITY:{ client:'DCC', tenant:'dublincity', name:'Dublin City Council' },
  DLR:{ client:'DLR', tenant:'dunlaoghaire', name:'Dun Laoghaire-Rathdown County Council' },
  FINGAL:{ client:'FG', tenant:'fingal', name:'Fingal County Council' },
  SOUTHDUBLIN:{ client:'SD', tenant:'southdublin', name:'South Dublin County Council' },
  WEXFORD:{ client:'WEXFORD', tenant:'wexford', name:'Wexford County Council' },
};

// localAuthorityId values are taken from the live ePlan v6 national map.
// `path` remains the legacy detail-site path because those detail pages expose
// the richest first-party lifecycle fields and remain stable.
const EPLAN_AUTHORITIES = {
  CARLOW:{ id:1, path:'CarlowCC', name:'Carlow County Council' },
  CAVAN:{ id:2, path:'CavanCC', name:'Cavan County Council' },
  CLARE:{ id:3, path:'ClareCC', name:'Clare County Council' },
  DONEGAL:{ id:6, path:'DonegalCC', name:'Donegal County Council' },
  GALWAYCITY:{ id:10, path:'GalwayCity', name:'Galway City Council' },
  GALWAYCOCO:{ id:11, path:'GalwayCC', name:'Galway County Council' },
  KERRY:{ id:12, path:'KerryCC', name:'Kerry County Council' },
  KILDARE:{ id:13, path:'KildareCC', name:'Kildare County Council' },
  KILKENNY:{ id:14, path:'KilkennyCC', name:'Kilkenny County Council' },
  LAOIS:{ id:15, path:'LaoisCC', name:'Laois County Council' },
  LEITRIM:{ id:16, path:'LeitrimCC', name:'Leitrim County Council' },
  LIMERICK:{ id:17, path:'LimerickCCC', name:'Limerick City and County Council' },
  LONGFORD:{ id:18, path:'LongfordCC', name:'Longford County Council' },
  LOUTH:{ id:19, path:'LouthCC', name:'Louth County Council' },
  MAYO:{ id:20, path:'MayoCC', name:'Mayo County Council' },
  MEATH:{ id:21, path:'MeathCC', name:'Meath County Council' },
  MONAGHAN:{ id:22, path:'MonaghanCC', name:'Monaghan County Council' },
  OFFALY:{ id:23, path:'OffalyCC', name:'Offaly County Council' },
  ROSCOMMON:{ id:24, path:'RoscommonCC', name:'Roscommon County Council' },
  SLIGO:{ id:25, path:'SligoCC', name:'Sligo County Council' },
  TIPPERARY:{ id:27, path:'TipperaryCC', name:'Tipperary County Council' },
  WATERFORD:{ id:28, path:'WaterfordCCC', name:'Waterford City and County Council' },
  WESTMEATH:{ id:29, path:'WestmeathCC', name:'Westmeath County Council' },
  WICKLOW:{ id:31, path:'WicklowCC', name:'Wicklow County Council' },
};

function planningSourceForAuthority(authorityCode) {
  const code=String(authorityCode||'').trim().toUpperCase();
  if (AGILE_AUTHORITIES[code]) return { family:'agile', code, ...AGILE_AUTHORITIES[code] };
  if (EPLAN_AUTHORITIES[code]) return { family:'eplan', code, ...EPLAN_AUTHORITIES[code] };
  const sourceName=NATIONAL_SOURCE_NAMES[code];
  return sourceName ? { family:'national', code, name:sourceName } : null;
}

export { NATIONAL_SOURCE_NAMES, AGILE_AUTHORITIES, EPLAN_AUTHORITIES, planningSourceForAuthority };

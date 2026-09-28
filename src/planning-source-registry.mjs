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

const EPLAN_AUTHORITIES = {
  CARLOW:{ path:'CarlowCC', name:'Carlow County Council' },
  CAVAN:{ path:'CavanCC', name:'Cavan County Council' },
  CLARE:{ path:'ClareCC', name:'Clare County Council' },
  DONEGAL:{ path:'DonegalCC', name:'Donegal County Council' },
  GALWAYCOCO:{ path:'GalwayCC', name:'Galway County Council' },
  GALWAYCITY:{ path:'GalwayCity', name:'Galway City Council' },
  KILDARE:{ path:'KildareCC', name:'Kildare County Council' },
  KILKENNY:{ path:'KilkennyCC', name:'Kilkenny County Council' },
  KERRY:{ path:'KerryCC', name:'Kerry County Council' },
  LAOIS:{ path:'LaoisCC', name:'Laois County Council' },
  LEITRIM:{ path:'LeitrimCC', name:'Leitrim County Council' },
  LIMERICK:{ path:'LimerickCCC', name:'Limerick City and County Council' },
  LONGFORD:{ path:'LongfordCC', name:'Longford County Council' },
  LOUTH:{ path:'LouthCC', name:'Louth County Council' },
  MAYO:{ path:'MayoCC', name:'Mayo County Council' },
  MEATH:{ path:'MeathCC', name:'Meath County Council' },
  MONAGHAN:{ path:'MonaghanCC', name:'Monaghan County Council' },
  OFFALY:{ path:'OffalyCC', name:'Offaly County Council' },
  ROSCOMMON:{ path:'RoscommonCC', name:'Roscommon County Council' },
  SLIGO:{ path:'SligoCC', name:'Sligo County Council' },
  TIPPERARY:{ path:'TipperaryCC', name:'Tipperary County Council' },
  WATERFORD:{ path:'WaterfordCCC', name:'Waterford City and County Council' },
  WESTMEATH:{ path:'WestmeathCC', name:'Westmeath County Council' },
  WICKLOW:{ path:'WicklowCC', name:'Wicklow County Council' },
};

function planningSourceForAuthority(authorityCode) {
  const code=String(authorityCode||'').trim().toUpperCase();
  if (AGILE_AUTHORITIES[code]) return { family:'agile', code, ...AGILE_AUTHORITIES[code] };
  if (EPLAN_AUTHORITIES[code]) return { family:'eplan', code, ...EPLAN_AUTHORITIES[code] };
  const sourceName=NATIONAL_SOURCE_NAMES[code];
  return sourceName ? { family:'national', code, name:sourceName } : null;
}

export { NATIONAL_SOURCE_NAMES, AGILE_AUTHORITIES, EPLAN_AUTHORITIES, planningSourceForAuthority };

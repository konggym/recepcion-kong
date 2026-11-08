/**
 * KONG GYM · ADMINISTRACIÓN (app de dueño y recepción)
 * ----------------------------------------------------
 * Conecta la app "Kong Gym Admin" con esta hoja: lee socios, pagos,
 * asistencias, ventas e inventario, y registra nuevos movimientos
 * escribiendo SOLO en las columnas de captura (las verdes/amarillas).
 * Las fórmulas de la hoja siguen haciendo todos los cálculos.
 *
 * Acceso con PIN:
 *   - Dueño: ve todo, incluidos ingresos; puede dar de baja socios y
 *     crear/editar productos.
 *   - Recepción: registra socios, pagos, entradas, ventas y mercancía
 *     recibida. No ve los ingresos totales.
 *
 * Instalación (una sola vez):
 *  1. En el proyecto de Apps Script "Kong Gym App", junto al archivo que
 *     ya tienes, crea uno nuevo (+ → Secuencia de comandos) llamado
 *     KongGym_Admin y pega este código.
 *  2. Cambia los dos PIN de abajo (6 dígitos, distintos entre sí).
 *  3. Implementar → Nueva implementación → Aplicación web →
 *     Ejecutar como: Yo · Quién tiene acceso: Cualquier persona →
 *     Implementar. Copia la URL que termina en /exec.
 *  (No modifica la implementación que ya usa la app de socios.)
 */

const ADM = {
  PIN_DUENO: '000000',      // ← CAMBIA este PIN (dueño)
  PIN_RECEPCION: '111111',  // ← CAMBIA este PIN (recepción)
  MAX_FALLOS: 8,            // intentos fallidos antes de bloquear
  BLOQUEO_MIN: 10,          // minutos de bloqueo
  PRIMERA_FILA_SOCIOS: 4, ULTIMA_FILA_SOCIOS: 503,
  PRIMERA_FILA_PAGOS: 4,  ULTIMA_FILA_PAGOS: 3003,
  PRIMERA_FILA_VENTAS: 5, ULTIMA_FILA_VENTAS: 2004,
  PRIMERA_FILA_INV: 5,    ULTIMA_FILA_INV: 34,
  DESFASE_ASISTENCIA: 4,  // fila en «Asistencias» = fila en «Socios» + 4
  HOJA_REGISTRO: 'Registro de entradas', // fecha y hora de cada entrada hecha desde la app
  HOJA_TURNOS: 'Turnos', HOJA_SALIDAS: 'Salidas', HOJA_PRESTAMOS: 'Préstamos',
  COL_TURNO_PAGOS: 13,   // columna M de «Pagos»: turno en que se cobró
  COL_TURNO_VENTAS: 11,  // columna K de «Ventas»: turno en que se vendió
  CATEGORIAS: ['Compras', 'Servicios', 'Nómina', 'Obra y mejoras', 'Pago de préstamo', 'Retiro del dueño'],
  ORIGENES: ['Caja', 'Cuenta / tarjeta'],
  PERSONAL_DEFAULT: 'Jennifer, Ariadna, Dueño',
  METODOS: ['Efectivo', 'Transferencia', 'Tarjeta']
};
// ID del Sheet KongGym_Control_de_Pagos (por si el script no está ligado a la hoja)
const ADM_SHEET_ID = '1msl-gFuLVfZ7RhCG9brJLqyAhaxYrR3xLMWAJsJVNj8';
function adm_ss_() { return SpreadsheetApp.getActive() || SpreadsheetApp.openById(ADM_SHEET_ID); }
const ADM_MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return adm_json_({ ok: false, error: 'formato' }); }
  try {
    const auth = adm_auth_(req.pin);
    if (!auth.ok) return adm_json_(auth);
    const rol = auth.rol;
    switch (req.accion) {
      case 'login': return adm_json_({ ok: true, rol: rol });
      case 'datos': return adm_json_(adm_datos_(rol));
      case 'socio_guardar': return adm_json_(adm_escribir_(rol, () => adm_socioGuardar_(rol, req.socio || {})));
      case 'pago': return adm_json_(adm_escribir_(rol, () => adm_pago_(rol, req.pago || {})));
      case 'asistencia': return adm_json_(adm_escribir_(rol, () => adm_asistencia_(rol, req)));
      case 'venta': return adm_json_(adm_escribir_(rol, () => adm_venta_(rol, req.venta || {})));
      case 'recibir': return adm_json_(adm_escribir_(rol, () => adm_recibir_(req)));
      case 'turno_abrir': return adm_json_(adm_escribir_(rol, () => adm_turnoAbrir_(req)));
      case 'turno_cerrar': return adm_json_(adm_escribir_(rol, () => adm_turnoCerrar_(req)));
      case 'salida': return adm_json_(adm_escribir_(rol, () => adm_salida_(rol, req.salida || {})));
      case 'exportar_todo': if (rol !== 'dueno') return adm_json_({ ok: false, error: 'permiso' }); return adm_json_(adm_exportarTodo_());
      case 'producto_guardar':
        if (rol !== 'dueno') return adm_json_({ ok: false, error: 'permiso' });
        return adm_json_(adm_escribir_(rol, () => adm_productoGuardar_(req.producto || {})));
      default: return adm_json_({ ok: false, error: 'accion' });
    }
  } catch (err) {
    console.error(err);
    return adm_json_({ ok: false, error: 'servidor', detalle: String(err && err.message || err) });
  }
}

/* ---------- Acceso ---------- */
function adm_auth_(pinRaw) {
  const pin = String(pinRaw || '').replace(/\D/g, '');
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('adm_fallos') || 0);
  if (fallos >= ADM.MAX_FALLOS) return { ok: false, error: 'bloqueado', minutos: ADM.BLOQUEO_MIN };
  if (pin && pin === ADM.PIN_DUENO) return { ok: true, rol: 'dueno' };
  if (pin && pin === ADM.PIN_RECEPCION) return { ok: true, rol: 'recepcion' };
  cache.put('adm_fallos', String(fallos + 1), ADM.BLOQUEO_MIN * 60);
  return { ok: false, error: 'pin', restantes: Math.max(0, ADM.MAX_FALLOS - fallos - 1) };
}

/* Toda escritura: un movimiento a la vez, y devuelve los datos ya recalculados */
function adm_escribir_(rol, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'ocupado' };
  let res;
  try {
    res = fn();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (!res || !res.ok) return res;
  res.datos = adm_datos_(rol);
  return res;
}

/* ---------- Lectura ---------- */
function adm_datos_(rol) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const hoy = new Date();
  const out = {
    ok: true, rol: rol,
    hoy: Utilities.formatDate(hoy, tz, 'yyyy-MM-dd'),
    hora: Utilities.formatDate(hoy, tz, 'HH:mm'),
    gym: adm_txt_(ss, 'Configuración', 'B4') || 'Kong Gym',
    horaGracias: adm_txt_(ss, 'Configuración', 'B28') || '8:00 PM'
  };

  // Tarifas y periodos
  const tar = ss.getSheetByName('Tarifas');
  const tv = tar.getRange('A3:G6').getValues();
  out.periodos = tv[0].slice(1).map(String);
  out.tarifas = {};
  for (let i = 1; i < tv.length; i++) {
    if (!tv[i][0]) continue;
    const m = String(tv[i][0]); out.tarifas[m] = {};
    out.periodos.forEach((p, j) => { out.tarifas[m][p] = Number(tv[i][j + 1]) || 0; });
  }
  out.membresias = Object.keys(out.tarifas);
  out.planes = ss.getSheetByName('Configuración').getRange('A16:A21').getDisplayValues().map(r => r[0]).filter(String);

  // Socios
  const sh = ss.getSheetByName('Socios');
  const n = ADM.ULTIMA_FILA_SOCIOS - ADM.PRIMERA_FILA_SOCIOS + 1;
  const sv = sh.getRange(ADM.PRIMERA_FILA_SOCIOS, 1, n, 25).getDisplayValues();
  out.socios = [];
  sv.forEach((r, i) => {
    if (!String(r[1]).trim()) return;
    out.socios.push({
      fila: ADM.PRIMERA_FILA_SOCIOS + i, id: r[0], nombre: String(r[1]).trim(), wa: r[2],
      membresia: r[3], plan: r[4], inscripcion: r[5], nacimiento: r[6], correo: r[7],
      emergencia: r[8], activo: r[9], notas: r[10], monto: adm_num_(r[11]),
      ultimoPago: r[12], vence: r[13], dias: r[14] === '' ? null : Number(r[14]),
      estado: r[15], url: r[20], graciasVisita: !!r[21], graciasNuevo: !!r[22],
      urlVisita: r[23], urlNuevo: r[24]
    });
  });

  // Asistencias del mes
  out.asistencia = adm_leerAsistencia_(ss, tz, hoy);

  // Pagos (últimos 400)
  const pg = ss.getSheetByName('Pagos');
  const pLast = adm_ultimaFila_(pg, ADM.PRIMERA_FILA_PAGOS, ADM.ULTIMA_FILA_PAGOS, [1, 4]);
  out.pagos = [];
  if (pLast >= ADM.PRIMERA_FILA_PAGOS) {
    const desde = Math.max(ADM.PRIMERA_FILA_PAGOS, pLast - 399);
    const pv = pg.getRange(desde, 1, pLast - desde + 1, ADM.COL_TURNO_PAGOS).getValues();
    pv.forEach((r, i) => {
      if (!(r[0] instanceof Date) || !r[1]) return;
      out.pagos.push({
        fila: desde + i, fecha: adm_ymd_(r[0], tz), socio: String(r[1]).trim(), id: String(r[7]),
        nombre: String(r[8]).trim(), periodo: String(r[2]), monto: Number(r[3]) || 0, metodo: String(r[4]),
        recibio: String(r[5]), notas: String(r[6]), lista: Number(r[9]) || 0,
        inicia: adm_ymd_(r[10], tz), vence: adm_ymd_(r[11], tz), turno: String(r[12] || '')
      });
    });
  }

  // Ventas (últimas 300)
  const vt = ss.getSheetByName('Ventas');
  const vLast = adm_ultimaFila_(vt, ADM.PRIMERA_FILA_VENTAS, ADM.ULTIMA_FILA_VENTAS, [1, 4]);
  out.ventas = [];
  if (vLast >= ADM.PRIMERA_FILA_VENTAS) {
    const desde = Math.max(ADM.PRIMERA_FILA_VENTAS, vLast - 299);
    const vv = vt.getRange(desde, 1, vLast - desde + 1, ADM.COL_TURNO_VENTAS).getValues();
    vv.forEach((r, i) => {
      if (!(r[0] instanceof Date) || !r[2]) return;
      out.ventas.push({
        fila: desde + i, fecha: adm_ymd_(r[0], tz), socio: String(r[1]).trim(), producto: String(r[2]),
        cantidad: Number(r[3]) || 0, precio: Number(r[4]) || 0, total: Number(r[5]) || 0,
        metodo: String(r[6]), notas: String(r[7]), turno: String(r[10] || '')
      });
    });
  }

  // Inventario
  const inv = ss.getSheetByName('Inventario');
  out.avisoMinimo = Number(inv.getRange('B3').getValue()) || 5;
  const iv = inv.getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 8).getValues();
  out.productos = [];
  iv.forEach((r, i) => {
    if (!String(r[0]).trim()) return;
    out.productos.push({
      fila: ADM.PRIMERA_FILA_INV + i, nombre: String(r[0]).trim(), precio: Number(r[1]) || 0,
      recibidas: Number(r[2]) || 0, vendidas: Number(r[3]) || 0, existencia: Number(r[4]) || 0,
      minimo: r[5] === '' ? null : Number(r[5]), estado: String(r[6]), acumulado: Number(r[7]) || 0
    });
  });

  // Panel
  const pa = ss.getSheetByName('Panel');
  const pv = pa.getRange('B4:B16').getValues().map(r => r[0]);
  out.panel = {
    activos: Number(pv[0]) || 0, porVencer: Number(pv[1]) || 0, vencidos: Number(pv[2]) || 0,
    sinPagos: Number(pv[3]) || 0, bajas: Number(pv[4]) || 0, pagosMes: Number(pv[6]) || 0,
    porMembresia: { Individual: Number(pv[10]) || 0, Pareja: Number(pv[11]) || 0, Estudiante: Number(pv[12]) || 0 },
    porAgotarse: Number(pa.getRange('B27').getValue()) || 0
  };
  if (rol === 'dueno') {
    out.panel.ingresoMes = Number(pv[5]) || 0;
    out.panel.renovacion = Number(pv[7]) || 0;
    const meses = pa.getRange('D5:H16').getValues();
    out.panel.meses = meses.map(r => ({
      mes: r[0] instanceof Date ? ADM_MESES[Number(Utilities.formatDate(r[0], tz, 'M')) - 1] + ' ' + Utilities.formatDate(r[0], tz, 'yy') : String(r[0]),
      mensualidades: Number(r[1]) || 0, pagos: Number(r[2]) || 0, ventas: Number(r[3]) || 0, total: Number(r[4]) || 0
    }));
    const met = pa.getRange('A19:B21').getValues();
    out.panel.metodos = met.map(r => ({ metodo: String(r[0]), monto: Number(r[1]) || 0 }));
    const des = pa.getRange('B24:B25').getValues();
    out.panel.mensualidadesMes = Number(des[0][0]) || 0;
    out.panel.ventasMes = Number(des[1][0]) || 0;
  }
  out.caja = adm_leerCaja_(ss, tz, rol, out);
  return out;
}

function adm_leerAsistencia_(ss, tz, hoy) {
  const sh = ss.getSheetByName('Asistencias');
  const mesHoja = sh.getRange('C3').getValue();
  const res = {
    mes: mesHoja instanceof Date ? Utilities.formatDate(mesHoja, tz, 'yyyy-MM') : '',
    mesActual: Utilities.formatDate(hoy, tz, 'yyyy-MM'),
    umbral: Number(sh.getRange('C4').getValue()) || 7,
    socios: {}, porDia: []
  };
  const horas = adm_horasDeHoy_(ss, tz, hoy); // ID → hora (desde el Registro de entradas)
  const vals = sh.getRange(8, 1, 500, 38).getDisplayValues(); // A..AL
  const dia = Number(Utilities.formatDate(hoy, tz, 'd'));
  const mismoMes = res.mes === res.mesActual;
  vals.forEach((r) => {
    const id = String(r[0]).trim();
    if (!id) return;
    const celda = mismoMes ? String(r[2 + dia]).trim() : '';
    res.socios[id] = {
      // Hora si se registró en la app; «✓» si solo hay una «A» (o una hora) capturada a mano
      hoy: celda ? (horas[id] || (/^\d{1,2}:\d{2}/.test(celda) ? celda : '✓')) : '',
      dias: Number(r[34]) || 0, ultima: r[35], sinVenir: r[36] === '' ? null : Number(r[36]), aviso: r[37]
    };
  });
  res.porDia = sh.getRange('D5:AH5').getValues()[0].map(v => (v === '' ? null : Number(v) || 0));
  return res;
}

/* Horas de entrada de hoy según el Registro de entradas (lee solo las últimas filas) */
function adm_horasDeHoy_(ss, tz, hoy) {
  const reg = ss.getSheetByName(ADM.HOJA_REGISTRO);
  const out = {};
  if (!reg || reg.getLastRow() < 2) return out;
  const ultima = reg.getLastRow(), desde = Math.max(2, ultima - 600);
  const v = reg.getRange(desde, 1, ultima - desde + 1, 3).getDisplayValues();
  const hoyTxt = Utilities.formatDate(hoy, tz, 'dd/MM/yyyy');
  v.forEach(r => { if (r[0] === hoyTxt && r[2]) out[String(r[2]).trim()] = r[1]; });
  return out;
}

function adm_hojaRegistro_(ss) {
  let reg = ss.getSheetByName(ADM.HOJA_REGISTRO);
  if (!reg) {
    reg = ss.insertSheet(ADM.HOJA_REGISTRO);
    reg.getRange('A1:E1').setValues([['Fecha', 'Hora', 'ID', 'Socio', 'Registró']])
      .setFontWeight('bold').setBackground('#1f4e3d').setFontColor('#ffffff');
    reg.setFrozenRows(1);
    reg.getRange('A:A').setNumberFormat('dd/mm/yyyy');
    reg.getRange('B:B').setNumberFormat('H:mm');
    reg.setColumnWidth(4, 220);
  }
  return reg;
}

/* ---------- Socios ---------- */
function adm_socioGuardar_(rol, s) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName('Socios');
  const nombre = String(s.nombre || '').trim().replace(/\s+/g, ' ');
  if (!nombre) return { ok: false, error: 'falta', campo: 'nombre' };
  const wa = String(s.wa || '').replace(/\D/g, '').slice(-10);
  if (wa && wa.length !== 10) return { ok: false, error: 'falta', campo: 'wa' };
  const datos = adm_datosTarifa_(ss);
  if (datos.membresias.indexOf(s.membresia) < 0) return { ok: false, error: 'falta', campo: 'membresia' };
  if (datos.planes.indexOf(s.plan) < 0) return { ok: false, error: 'falta', campo: 'plan' };

  let fila = Number(s.fila) || 0;
  let activo = 'Sí';
  if (fila) {
    const actual = sh.getRange(fila, 1, 1, 10).getDisplayValues()[0];
    if (actual[0] !== s.id) return { ok: false, error: 'no_coincide' };
    activo = actual[9] || 'Sí';
    if (rol === 'dueno' && (s.activo === 'Sí' || s.activo === 'No')) activo = s.activo;
  } else {
    const col = sh.getRange(ADM.PRIMERA_FILA_SOCIOS, 2, ADM.ULTIMA_FILA_SOCIOS - ADM.PRIMERA_FILA_SOCIOS + 1, 1).getValues();
    for (let i = 0; i < col.length; i++) {
      if (!String(col[i][0]).trim()) { fila = ADM.PRIMERA_FILA_SOCIOS + i; break; }
    }
    if (!fila) return { ok: false, error: 'lleno' };
  }
  const fila10 = [
    nombre, wa, s.membresia, s.plan,
    adm_fecha_(s.inscripcion, tz) || (fila && s.fila ? '' : adm_fecha_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz)),
    adm_fecha_(s.nacimiento, tz) || '',
    String(s.correo || '').trim(), String(s.emergencia || '').trim(), activo, String(s.notas || '').trim()
  ];
  sh.getRange(fila, 2, 1, 10).setValues([fila10]);
  if (wa) sh.getRange(fila, 3).setNumberFormat('@').setValue(wa);
  const id = sh.getRange(fila, 1).getDisplayValue();
  return { ok: true, id: id, fila: fila, nuevo: !s.fila };
}

/* ---------- Pagos ---------- */
function adm_pago_(rol, p) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const socio = adm_socioPorFila_(ss, p.fila, p.id);
  if (!socio) return { ok: false, error: 'socio' };
  const datos = adm_datosTarifa_(ss);
  if (datos.planes.indexOf(p.periodo) < 0) return { ok: false, error: 'falta', campo: 'periodo' };
  const monto = Number(p.monto);
  if (!(monto >= 0)) return { ok: false, error: 'falta', campo: 'monto' };
  if (ADM.METODOS.indexOf(p.metodo) < 0) return { ok: false, error: 'falta', campo: 'metodo' };
  const fecha = adm_fecha_(p.fecha, tz) || adm_fecha_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz);

  const turno = adm_turnoAbierto_(ss);
  if (p.metodo === 'Efectivo' && !turno) return { ok: false, error: 'sin_turno' };
  const sh = ss.getSheetByName('Pagos');
  const fila = adm_ultimaFila_(sh, ADM.PRIMERA_FILA_PAGOS, ADM.ULTIMA_FILA_PAGOS, [1, 4]) + 1;
  if (fila > ADM.ULTIMA_FILA_PAGOS) return { ok: false, error: 'lleno' };
  sh.getRange(fila, 1, 1, 7).setValues([[fecha, socio.etiqueta, p.periodo, monto, p.metodo,
    rol === 'dueno' ? 'Dueño' : 'Recepción', String(p.notas || '').trim()]]);
  if (turno) sh.getRange(fila, ADM.COL_TURNO_PAGOS).setValue(turno.id);
  SpreadsheetApp.flush();
  const r = sh.getRange(fila, 10, 1, 3).getValues()[0];
  return { ok: true, fila: fila, lista: Number(r[0]) || 0, inicia: adm_ymd_(r[1], tz), vence: adm_ymd_(r[2], tz) };
}

/* ---------- Asistencias ---------- */
function adm_asistencia_(rol, req) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const socio = adm_socioPorFila_(ss, req.fila, req.id);
  if (!socio) return { ok: false, error: 'socio' };
  const sh = ss.getSheetByName('Asistencias');
  const ahora = new Date();
  const mes = adm_asegurarMes_(ss, sh, tz, ahora);
  if (!mes.ok) return mes;

  const filaA = socio.fila + ADM.DESFASE_ASISTENCIA;
  if (String(sh.getRange(filaA, 1).getDisplayValue()).trim() !== socio.id) return { ok: false, error: 'asistencia_fila' };
  const dia = Number(Utilities.formatDate(ahora, tz, 'd'));
  const celda = sh.getRange(filaA, 3 + dia);
  const hoyYmd = Utilities.formatDate(ahora, tz, 'yyyy-MM-dd');
  const reg = adm_hojaRegistro_(ss);
  if (req.borrar) {
    celda.clearContent();
    // Quita también la(s) fila(s) de hoy de ese socio en el Registro
    const hoyTxt = Utilities.formatDate(ahora, tz, 'dd/MM/yyyy');
    const ultima = reg.getLastRow();
    if (ultima >= 2) {
      const desde = Math.max(2, ultima - 600);
      const v = reg.getRange(desde, 1, ultima - desde + 1, 3).getDisplayValues();
      for (let i = v.length - 1; i >= 0; i--) {
        if (v[i][0] === hoyTxt && String(v[i][2]).trim() === socio.id) reg.deleteRow(desde + i);
      }
    }
    return { ok: true, borrado: true };
  }
  const previa = String(celda.getDisplayValue()).trim();
  if (previa) {
    const h = adm_horasDeHoy_(ss, tz, ahora)[socio.id];
    return { ok: true, ya: true, hora: h || (/^\d{1,2}:\d{2}/.test(previa) ? previa : '') };
  }
  const hhmm = Utilities.formatDate(ahora, tz, 'H:mm');
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  celda.setValue('A');
  reg.appendRow([adm_fecha_(hoyYmd, tz), (Number(m[1]) * 60 + Number(m[2])) / 1440, socio.id,
    socio.etiqueta.replace(/^\S+ - /, '').trim(), rol === 'dueno' ? 'Dueño' : 'Recepción']);
  reg.getRange(reg.getLastRow(), 1).setNumberFormat('dd/mm/yyyy');
  reg.getRange(reg.getLastRow(), 2).setNumberFormat('H:mm');
  return { ok: true, hora: hhmm, mesNuevo: mes.nuevo || false };
}

/* Al empezar un mes nuevo: guarda una copia del mes anterior y deja la pestaña lista */
function adm_asegurarMes_(ss, sh, tz, ahora) {
  const c3 = sh.getRange('C3').getValue();
  const actual = Utilities.formatDate(ahora, tz, 'yyyy-MM');
  const hoja = c3 instanceof Date ? Utilities.formatDate(c3, tz, 'yyyy-MM') : '';
  if (hoja === actual) return { ok: true };
  if (hoja > actual) return { ok: false, error: 'mes_futuro' };
  if (hoja) {
    const y = hoja.slice(0, 4), mm = Number(hoja.slice(5, 7));
    let nombre = 'Asistencias ' + ADM_MESES[mm - 1] + ' ' + y, k = 2;
    while (ss.getSheetByName(nombre)) nombre = 'Asistencias ' + ADM_MESES[mm - 1] + ' ' + y + ' (' + (k++) + ')';
    const copia = sh.copyTo(ss).setName(nombre);
    // La copia queda como archivo: valores fijos para que no cambie con el tiempo
    const rango = copia.getRange(1, 1, copia.getMaxRows(), copia.getMaxColumns());
    rango.copyTo(rango, SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);
  }
  sh.getRange('C3').setValue(adm_fecha_(actual + '-01', tz));
  sh.getRange(8, 4, 500, 31).clearContent();
  return { ok: true, nuevo: true };
}

/* ---------- Ventas e inventario ---------- */
function adm_venta_(rol, v) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  // El socio es opcional: si viene, se valida; si no, la venta queda sin socio
  const socio = v.fila ? adm_socioPorFila_(ss, v.fila, v.id) : null;
  if (v.fila && !socio) return { ok: false, error: 'socio' };
  const prod = adm_producto_(ss, v.producto);
  if (!prod) return { ok: false, error: 'falta', campo: 'producto' };
  const cant = Math.floor(Number(v.cantidad));
  if (!(cant >= 1)) return { ok: false, error: 'falta', campo: 'cantidad' };
  if (ADM.METODOS.indexOf(v.metodo) < 0) return { ok: false, error: 'falta', campo: 'metodo' };
  const turno = adm_turnoAbierto_(ss);
  if (v.metodo === 'Efectivo' && !turno) return { ok: false, error: 'sin_turno' };
  const sh = ss.getSheetByName('Ventas');
  const fila = adm_ultimaFila_(sh, ADM.PRIMERA_FILA_VENTAS, ADM.ULTIMA_FILA_VENTAS, [1, 4]) + 1;
  if (fila > ADM.ULTIMA_FILA_VENTAS) return { ok: false, error: 'lleno' };
  const hoy = adm_fecha_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz);
  sh.getRange(fila, 1, 1, 4).setValues([[hoy, socio ? socio.etiqueta : '', prod.nombre, cant]]);
  sh.getRange(fila, 7, 1, 2).setValues([[v.metodo, String(v.notas || '').trim()]]);
  if (turno) sh.getRange(fila, ADM.COL_TURNO_VENTAS).setValue(turno.id);
  SpreadsheetApp.flush();
  const total = Number(sh.getRange(fila, 6).getValue()) || 0;
  const aviso = String(sh.getRange(fila, 10).getDisplayValue() || '');
  return { ok: true, fila: fila, total: total, aviso: aviso };
}

function adm_recibir_(req) {
  const ss = adm_ss_();
  const prod = adm_producto_(ss, req.producto);
  if (!prod) return { ok: false, error: 'falta', campo: 'producto' };
  const piezas = Math.floor(Number(req.piezas));
  if (!(piezas >= 1) || piezas > 5000) return { ok: false, error: 'falta', campo: 'piezas' };
  const c = ss.getSheetByName('Inventario').getRange(prod.fila, 3);
  c.setValue((Number(c.getValue()) || 0) + piezas);
  return { ok: true };
}

function adm_productoGuardar_(p) {
  const ss = adm_ss_();
  const sh = ss.getSheetByName('Inventario');
  const nombre = String(p.nombre || '').trim();
  const precio = Number(p.precio);
  if (!nombre) return { ok: false, error: 'falta', campo: 'nombre' };
  if (!(precio >= 0)) return { ok: false, error: 'falta', campo: 'precio' };
  const minimo = p.minimo === '' || p.minimo === null || p.minimo === undefined ? '' : Math.max(0, Math.floor(Number(p.minimo)) || 0);
  const col = sh.getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 1).getValues();
  let fila = Number(p.fila) || 0;
  for (let i = 0; i < col.length; i++) {
    const otra = ADM.PRIMERA_FILA_INV + i;
    if (otra !== fila && String(col[i][0]).trim().toLowerCase() === nombre.toLowerCase()) return { ok: false, error: 'duplicado' };
  }
  if (fila) {
    // Cambiar el nombre rompería el historial de ventas: solo precio y mínimo
    sh.getRange(fila, 2).setValue(precio);
    sh.getRange(fila, 6).setValue(minimo);
    return { ok: true, fila: fila };
  }
  for (let i = 0; i < col.length; i++) {
    if (!String(col[i][0]).trim()) { fila = ADM.PRIMERA_FILA_INV + i; break; }
  }
  if (!fila) return { ok: false, error: 'lleno' };
  sh.getRange(fila, 1, 1, 3).setValues([[nombre, precio, Math.max(0, Math.floor(Number(p.piezas) || 0))]]);
  sh.getRange(fila, 6).setValue(minimo);
  // Si esa fila no trae fórmulas, las copia de la fila de arriba
  if (!sh.getRange(fila, 4).getFormula() && fila > ADM.PRIMERA_FILA_INV) {
    [4, 5, 7, 8].forEach(c => sh.getRange(fila - 1, c).copyTo(sh.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false));
  }
  return { ok: true, fila: fila };
}

/* ---------- Utilidades ---------- */
function adm_socioPorFila_(ss, filaRaw, idRaw) {
  const fila = Number(filaRaw);
  if (!(fila >= ADM.PRIMERA_FILA_SOCIOS && fila <= ADM.ULTIMA_FILA_SOCIOS)) return null;
  const r = ss.getSheetByName('Socios').getRange(fila, 1, 1, 2).getValues()[0];
  const id = String(r[0]).trim();
  if (!id || id !== String(idRaw || '').trim() || !String(r[1]).trim()) return null;
  return { fila: fila, id: id, etiqueta: id + ' - ' + r[1] }; // igual que la columna _etiqueta
}

function adm_producto_(ss, nombreRaw) {
  const nombre = String(nombreRaw || '').trim();
  if (!nombre) return null;
  const v = ss.getSheetByName('Inventario').getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 1).getValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() === nombre) return { fila: ADM.PRIMERA_FILA_INV + i, nombre: String(v[i][0]) };
  }
  return null;
}

function adm_datosTarifa_(ss) {
  return {
    membresias: ss.getSheetByName('Tarifas').getRange('A4:A6').getDisplayValues().map(r => r[0]).filter(String),
    planes: ss.getSheetByName('Configuración').getRange('A16:A21').getDisplayValues().map(r => r[0]).filter(String)
  };
}

/* Última fila con datos en alguna de las columnas indicadas (1 = A) */
function adm_ultimaFila_(sh, primera, ultima, cols) {
  const maxCol = Math.max.apply(null, cols);
  const v = sh.getRange(primera, 1, ultima - primera + 1, maxCol).getValues();
  for (let i = v.length - 1; i >= 0; i--) {
    for (let k = 0; k < cols.length; k++) {
      const x = v[i][cols[k] - 1];
      if (x !== '' && x !== null) return primera + i;
    }
  }
  return primera - 1;
}

function adm_fecha_(ymd, tz) {
  const s = String(ymd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Utilities.parseDate(s, tz, 'yyyy-MM-dd'); // medianoche en la zona del Sheet
}
function adm_ymd_(v, tz) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : ''; }
function adm_num_(s) { const n = Number(String(s).replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n; }
function adm_txt_(ss, hoja, a1) { const h = ss.getSheetByName(hoja); return h ? String(h.getRange(a1).getDisplayValue()) : ''; }
function adm_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =====================================================================
 * CAJA: turnos por persona, salidas de dinero, corte y préstamos
 * ===================================================================== */
const ADM_TURNO_COLS = ['ID', 'Persona', 'Fecha apertura', 'Hora apertura', 'Dejó el turno anterior', 'Efectivo inicial (contado)',
  'Diferencia apertura', 'Cobros en efectivo', 'Ventas en efectivo', 'Salidas de caja', 'Esperado en caja', 'Contado al cierre',
  'Diferencia', 'Motivo', 'Transferencias', 'Tarjeta', 'Fecha cierre', 'Hora cierre', 'Estado'];
const ADM_SALIDA_COLS = ['Fecha', 'Hora', 'Categoría', 'Concepto', 'Pagado a', 'Monto', 'Origen', 'Préstamo', 'Turno', 'Registró', 'Notas'];

/* Crea las pestañas de caja la primera vez (con el préstamo actual ya cargado) */
function adm_asegurarCaja_(ss) {
  if (ss.getSheetByName(ADM.HOJA_TURNOS) && ss.getSheetByName(ADM.HOJA_SALIDAS) && ss.getSheetByName(ADM.HOJA_PRESTAMOS)) return;
  {
    const head = (sh, cols) => {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#1f4e3d').setFontColor('#ffffff').setWrap(true);
      sh.setFrozenRows(1);
    };
    if (!ss.getSheetByName(ADM.HOJA_TURNOS)) {
      const t = ss.insertSheet(ADM.HOJA_TURNOS);
      head(t, ADM_TURNO_COLS);
      t.getRange('C:C').setNumberFormat('dd/mm/yyyy'); t.getRange('Q:Q').setNumberFormat('dd/mm/yyyy');
      t.getRange('D:D').setNumberFormat('H:mm'); t.getRange('R:R').setNumberFormat('H:mm');
      t.getRange('E:P').setNumberFormat('$#,##0.00');
    }
    if (!ss.getSheetByName(ADM.HOJA_SALIDAS)) {
      const s = ss.insertSheet(ADM.HOJA_SALIDAS);
      head(s, ADM_SALIDA_COLS);
      s.getRange('A:A').setNumberFormat('dd/mm/yyyy'); s.getRange('B:B').setNumberFormat('H:mm'); s.getRange('F:F').setNumberFormat('$#,##0.00');
      s.getRange('C2:C5000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ADM.CATEGORIAS, true).build());
      s.getRange('G2:G5000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ADM.ORIGENES, true).build());
      s.setColumnWidth(4, 220);
    }
    if (!ss.getSheetByName(ADM.HOJA_PRESTAMOS)) {
      const p = ss.insertSheet(ADM.HOJA_PRESTAMOS);
      head(p, ['Préstamo', 'Monto total', 'Pagado antes de la app', 'Abono sugerido', 'Notas', 'Pagado total', 'Restante', 'Avance']);
      p.getRange('A2:E2').setValues([['Préstamo $27,500', 27500, 1620, 270, '6 abonos diarios de $270 antes de usar la app']]);
      const f = [];
      for (let r = 2; r <= 30; r++) {
        f.push(['=IF(A' + r + '="","",N(C' + r + ')+SUMIFS(' + "'" + ADM.HOJA_SALIDAS + "'" + '!$F:$F,' + "'" + ADM.HOJA_SALIDAS + "'" + '!$H:$H,A' + r + ',' + "'" + ADM.HOJA_SALIDAS + "'" + '!$C:$C,"Pago de préstamo"))',
          '=IF(A' + r + '="","",B' + r + '-F' + r + ')', '=IF(OR(A' + r + '="",N(B' + r + ')=0),"",F' + r + '/B' + r + ')']);
      }
      p.getRange(2, 6, 29, 3).setFormulas(f);
      p.getRange('B:D').setNumberFormat('$#,##0.00'); p.getRange('F:G').setNumberFormat('$#,##0.00'); p.getRange('H:H').setNumberFormat('0%');
      p.setColumnWidth(1, 200); p.setColumnWidth(5, 260);
    }
    // Encabezados de turno en Pagos y Ventas, y lista de personal en Configuración
    const pg = ss.getSheetByName('Pagos'); if (!pg.getRange(3, ADM.COL_TURNO_PAGOS).getValue()) pg.getRange(3, ADM.COL_TURNO_PAGOS).setValue('Turno');
    const vt = ss.getSheetByName('Ventas'); if (!vt.getRange(4, ADM.COL_TURNO_VENTAS).getValue()) vt.getRange(4, ADM.COL_TURNO_VENTAS).setValue('Turno');
    const cf = ss.getSheetByName('Configuración');
    if (!cf.getRange('A31').getValue()) {
      cf.getRange('A31:B31').setValues([['Personal que abre turno de caja (separado por comas)', ADM.PERSONAL_DEFAULT]]);
      cf.getRange('B31').setBackground('#fff2cc');
    }
    SpreadsheetApp.flush();
  }
}

function adm_turnoAbierto_(ss) {
  const t = ss.getSheetByName(ADM.HOJA_TURNOS);
  if (!t || t.getLastRow() < 2) return null;
  const last = t.getLastRow(), desde = Math.max(2, last - 50);
  const v = t.getRange(desde, 1, last - desde + 1, ADM_TURNO_COLS.length).getValues();
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i][18] === 'Abierto') return { fila: desde + i, id: String(v[i][0]), persona: String(v[i][1]), fecha: v[i][2], hora: v[i][3], inicial: Number(v[i][5]) || 0 };
  }
  return null;
}

/* Suma lo que entró y salió de caja en un turno */
function adm_sumasTurno_(ss, id) {
  const s = { cobros: 0, ventas: 0, salidas: 0, transferencias: 0, tarjeta: 0, movs: [] };
  const metodo = (m, x) => { if (m === 'Transferencia') s.transferencias += x; else if (m === 'Tarjeta') s.tarjeta += x; };
  const pg = ss.getSheetByName('Pagos');
  const pl = adm_ultimaFila_(pg, ADM.PRIMERA_FILA_PAGOS, ADM.ULTIMA_FILA_PAGOS, [1, 4]);
  if (pl >= ADM.PRIMERA_FILA_PAGOS) {
    const d = Math.max(ADM.PRIMERA_FILA_PAGOS, pl - 300);
    pg.getRange(d, 1, pl - d + 1, ADM.COL_TURNO_PAGOS).getValues().forEach(r => {
      if (String(r[12]) !== id) return;
      const x = Number(r[3]) || 0;
      if (r[4] === 'Efectivo') s.cobros += x; else metodo(r[4], x);
      s.movs.push({ tipo: 'pago', texto: String(r[8] || r[1]).trim() + ' · ' + r[2], metodo: String(r[4]), monto: x });
    });
  }
  const vt = ss.getSheetByName('Ventas');
  const vl = adm_ultimaFila_(vt, ADM.PRIMERA_FILA_VENTAS, ADM.ULTIMA_FILA_VENTAS, [1, 4]);
  if (vl >= ADM.PRIMERA_FILA_VENTAS) {
    const d = Math.max(ADM.PRIMERA_FILA_VENTAS, vl - 300);
    vt.getRange(d, 1, vl - d + 1, ADM.COL_TURNO_VENTAS).getValues().forEach(r => {
      if (String(r[10]) !== id) return;
      const x = Number(r[5]) || 0;
      if (r[6] === 'Efectivo') s.ventas += x; else metodo(r[6], x);
      s.movs.push({ tipo: 'venta', texto: r[3] + ' × ' + r[2], metodo: String(r[6]), monto: x });
    });
  }
  const sa = ss.getSheetByName(ADM.HOJA_SALIDAS);
  if (sa && sa.getLastRow() >= 2) {
    const l = sa.getLastRow(), d = Math.max(2, l - 300);
    sa.getRange(d, 1, l - d + 1, ADM_SALIDA_COLS.length).getValues().forEach(r => {
      if (String(r[8]) !== id || r[6] !== 'Caja') return;
      const x = Number(r[5]) || 0;
      s.salidas += x;
      s.movs.push({ tipo: 'salida', texto: r[2] + ' · ' + r[3], metodo: 'Caja', monto: -x });
    });
  }
  return s;
}

function adm_ultimoCierre_(ss) {
  const t = ss.getSheetByName(ADM.HOJA_TURNOS);
  if (!t || t.getLastRow() < 2) return null;
  const last = t.getLastRow(), desde = Math.max(2, last - 50);
  const v = t.getRange(desde, 1, last - desde + 1, ADM_TURNO_COLS.length).getValues();
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i][18] === 'Cerrado') return { persona: String(v[i][1]), contado: Number(v[i][11]) || 0, fecha: v[i][16], hora: v[i][17] };
  }
  return null;
}

function adm_turnoAbrir_(req) {
  const ss = adm_ss_();
  adm_asegurarCaja_(ss);
  const tz = ss.getSpreadsheetTimeZone();
  if (adm_turnoAbierto_(ss)) return { ok: false, error: 'turno_abierto' };
  const persona = String(req.persona || '').trim();
  if (adm_personal_(ss).indexOf(persona) < 0) return { ok: false, error: 'falta', campo: 'persona' };
  const contado = Number(req.contado);
  if (!(contado >= 0)) return { ok: false, error: 'falta', campo: 'contado' };
  const ant = adm_ultimoCierre_(ss);
  const dejo = ant ? ant.contado : contado;
  const ahora = new Date();
  const id = 'T-' + Utilities.formatDate(ahora, tz, 'yyMMdd-HHmm');
  const fila = [id, persona, adm_fecha_(Utilities.formatDate(ahora, tz, 'yyyy-MM-dd'), tz), adm_horaNum_(ahora, tz), dejo, contado,
    contado - dejo, '', '', '', '', '', '', String(req.motivo || '').trim(), '', '', '', '', 'Abierto'];
  const t = ss.getSheetByName(ADM.HOJA_TURNOS);
  t.appendRow(fila);
  t.getRange(t.getLastRow(), 4).setNumberFormat('H:mm');
  return { ok: true, id: id, diferencia: contado - dejo };
}

function adm_turnoCerrar_(req) {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const turno = adm_turnoAbierto_(ss);
  if (!turno || turno.id !== String(req.id || '')) return { ok: false, error: 'sin_turno' };
  const contado = Number(req.contado);
  if (!(contado >= 0)) return { ok: false, error: 'falta', campo: 'contado' };
  const s = adm_sumasTurno_(ss, turno.id);
  const esperado = turno.inicial + s.cobros + s.ventas - s.salidas;
  const dif = Math.round((contado - esperado) * 100) / 100;
  let motivo = String(req.motivo || '').trim();
  if (dif !== 0 && !motivo) return { ok: false, error: 'falta', campo: 'motivo' };
  const ahora = new Date();
  const t = ss.getSheetByName(ADM.HOJA_TURNOS);
  const motivoApertura = String(t.getRange(turno.fila, 14).getValue() || '').trim();
  if (motivoApertura) motivo = 'Apertura: ' + motivoApertura + (motivo ? ' · Cierre: ' + motivo : '');
  t.getRange(turno.fila, 8, 1, 12).setValues([[s.cobros, s.ventas, s.salidas, esperado, contado, dif, motivo, s.transferencias, s.tarjeta,
    adm_fecha_(Utilities.formatDate(ahora, tz, 'yyyy-MM-dd'), tz), adm_horaNum_(ahora, tz), 'Cerrado']]);
  t.getRange(turno.fila, 18).setNumberFormat('H:mm');
  return { ok: true, esperado: esperado, contado: contado, diferencia: dif };
}

function adm_salida_(rol, x) {
  const ss = adm_ss_();
  adm_asegurarCaja_(ss);
  const tz = ss.getSpreadsheetTimeZone();
  const cat = String(x.categoria || '');
  if (ADM.CATEGORIAS.indexOf(cat) < 0) return { ok: false, error: 'falta', campo: 'categoria' };
  if (cat === 'Retiro del dueño' && rol !== 'dueno') return { ok: false, error: 'permiso' };
  const origen = rol === 'dueno' ? String(x.origen || 'Caja') : 'Caja'; // recepción solo registra caja chica
  if (ADM.ORIGENES.indexOf(origen) < 0) return { ok: false, error: 'falta', campo: 'origen' };
  const monto = Math.round(Number(x.monto) * 100) / 100;
  if (!(monto > 0)) return { ok: false, error: 'falta', campo: 'monto' };
  const concepto = String(x.concepto || '').trim();
  if (!concepto) return { ok: false, error: 'falta', campo: 'concepto' };
  let prestamo = '';
  if (cat === 'Pago de préstamo') {
    prestamo = String(x.prestamo || '').trim();
    if (adm_prestamos_(ss).map(p => p.nombre).indexOf(prestamo) < 0) return { ok: false, error: 'falta', campo: 'prestamo' };
  }
  const turno = adm_turnoAbierto_(ss);
  if (origen === 'Caja' && !turno) return { ok: false, error: 'sin_turno' };
  const ahora = new Date();
  const sh = ss.getSheetByName(ADM.HOJA_SALIDAS);
  sh.appendRow([adm_fecha_(Utilities.formatDate(ahora, tz, 'yyyy-MM-dd'), tz), adm_horaNum_(ahora, tz), cat, concepto,
    String(x.pagadoA || '').trim(), monto, origen, prestamo, origen === 'Caja' && turno ? turno.id : '',
    rol === 'dueno' ? 'Dueño' : (turno ? turno.persona : 'Recepción'), String(x.notas || '').trim()]);
  sh.getRange(sh.getLastRow(), 1).setNumberFormat('dd/mm/yyyy');
  sh.getRange(sh.getLastRow(), 2).setNumberFormat('H:mm');
  return { ok: true };
}

function adm_personal_(ss) {
  const v = String(ss.getSheetByName('Configuración').getRange('B31').getDisplayValue() || ADM.PERSONAL_DEFAULT);
  return v.split(',').map(x => x.trim()).filter(String);
}

function adm_prestamos_(ss) {
  const p = ss.getSheetByName(ADM.HOJA_PRESTAMOS);
  if (!p || p.getLastRow() < 2) return [];
  return p.getRange(2, 1, Math.min(29, p.getLastRow() - 1), 8).getValues().filter(r => String(r[0]).trim()).map(r => ({
    nombre: String(r[0]).trim(), monto: Number(r[1]) || 0, previo: Number(r[2]) || 0, abono: Number(r[3]) || 0,
    notas: String(r[4]), pagado: Number(r[5]) || 0, restante: Number(r[6]) || 0
  }));
}

function adm_leerCaja_(ss, tz, rol, out) {
  adm_asegurarCaja_(ss);
  const caja = { personal: adm_personal_(ss), categorias: ADM.CATEGORIAS, origenes: ADM.ORIGENES, prestamos: adm_prestamos_(ss) };
  const t = adm_turnoAbierto_(ss);
  if (t) {
    const s = adm_sumasTurno_(ss, t.id);
    caja.turno = { id: t.id, persona: t.persona, fecha: adm_ymd_(t.fecha, tz), hora: adm_horaTxt_(t.hora, tz), inicial: t.inicial,
      cobros: s.cobros, ventas: s.ventas, salidas: s.salidas, transferencias: s.transferencias, tarjeta: s.tarjeta,
      esperado: t.inicial + s.cobros + s.ventas - s.salidas, movs: s.movs };
  } else caja.turno = null;
  const u = adm_ultimoCierre_(ss);
  caja.ultimoCierre = u ? { persona: u.persona, contado: u.contado, fecha: adm_ymd_(u.fecha, tz), hora: adm_horaTxt_(u.hora, tz) } : null;

  // Salidas (las últimas 200)
  const sa = ss.getSheetByName(ADM.HOJA_SALIDAS);
  const todas = sa.getLastRow() >= 2 ? sa.getRange(2, 1, sa.getLastRow() - 1, ADM_SALIDA_COLS.length).getValues().filter(r => r[0] instanceof Date && Number(r[5])) : [];
  caja.salidas = todas.slice(-200).map(r => ({
    fecha: adm_ymd_(r[0], tz), hora: adm_horaTxt_(r[1], tz), categoria: String(r[2]), concepto: String(r[3]), pagadoA: String(r[4]),
    monto: Number(r[5]) || 0, origen: String(r[6]), prestamo: String(r[7]), turno: String(r[8]), registro: String(r[9]), notas: String(r[10])
  }));
  if (rol !== 'dueno') { // recepción solo ve las salidas de caja
    caja.salidas = caja.salidas.filter(x => x.origen === 'Caja' && x.categoria !== 'Retiro del dueño');
    return caja;
  }

  // Métricas del dueño: gastos por mes y categoría (12 meses), cortes recientes
  const meses = {};
  todas.forEach(r => {
    const k = Utilities.formatDate(r[0], tz, 'yyyy-MM');
    meses[k] = meses[k] || {};
    meses[k][r[2]] = (meses[k][r[2]] || 0) + (Number(r[5]) || 0);
  });
  caja.gastosMes = meses;
  const tu = ss.getSheetByName(ADM.HOJA_TURNOS);
  caja.cortes = tu.getLastRow() >= 2 ? tu.getRange(Math.max(2, tu.getLastRow() - 59), 1, Math.min(60, tu.getLastRow() - 1), ADM_TURNO_COLS.length).getValues()
    .filter(r => r[18] === 'Cerrado').reverse().map(r => ({
      id: String(r[0]), persona: String(r[1]), fecha: adm_ymd_(r[2], tz), hora: adm_horaTxt_(r[3], tz), inicial: Number(r[5]) || 0,
      difApertura: Number(r[6]) || 0, cobros: Number(r[7]) || 0, ventas: Number(r[8]) || 0, salidas: Number(r[9]) || 0,
      esperado: Number(r[10]) || 0, contado: Number(r[11]) || 0, diferencia: Number(r[12]) || 0, motivo: String(r[13]),
      transferencias: Number(r[14]) || 0, tarjeta: Number(r[15]) || 0, fechaCierre: adm_ymd_(r[16], tz), horaCierre: adm_horaTxt_(r[17], tz)
    })) : [];
  return caja;
}

function adm_horaNum_(d, tz) {
  const h = Number(Utilities.formatDate(d, tz, 'H')), m = Number(Utilities.formatDate(d, tz, 'm'));
  return (h * 60 + m) / 1440;
}
function adm_horaTxt_(v, tz) {
  if (typeof v === 'number') { const t = Math.round(v * 1440); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'H:mm');
  return String(v || '');
}

/* ---------- Exportación completa (para migrar a la base de la app) ---------- */
function adm_exportarTodo_() {
  const ss = adm_ss_(), tz = ss.getSpreadsheetTimeZone();
  const ymd = v => v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
  const hm = v => v instanceof Date ? Utilities.formatDate(v, tz, 'H:mm') : (typeof v === 'number' ? (() => { const t = Math.round(v * 1440); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); })() : String(v || ''));
  const idDe = etiqueta => String(etiqueta || '').split(' - ')[0].trim();
  const out = { ok: true };
  // Socios
  const so = ss.getSheetByName('Socios').getRange(ADM.PRIMERA_FILA_SOCIOS, 1, ADM.ULTIMA_FILA_SOCIOS - ADM.PRIMERA_FILA_SOCIOS + 1, 11).getValues();
  out.socios = so.filter(r => String(r[1]).trim()).map(r => ({
    num: Number(String(r[0]).replace(/\D/g, '')), id: String(r[0]).trim(), nombre: String(r[1]).trim().replace(/\s+/g, ' '),
    wa: String(r[2]).replace(/\D/g, '').slice(-10), membresia: String(r[3]), plan: String(r[4]), inscripcion: ymd(r[5]), nacimiento: ymd(r[6]),
    correo: String(r[7]).trim(), emergencia: String(r[8]).trim(), activo: String(r[9]).trim() !== 'No', notas: String(r[10]).trim()
  }));
  // Pagos
  const pg = ss.getSheetByName('Pagos');
  const pl = adm_ultimaFila_(pg, ADM.PRIMERA_FILA_PAGOS, ADM.ULTIMA_FILA_PAGOS, [1, 4]);
  out.pagos = pl < ADM.PRIMERA_FILA_PAGOS ? [] : pg.getRange(ADM.PRIMERA_FILA_PAGOS, 1, pl - ADM.PRIMERA_FILA_PAGOS + 1, ADM.COL_TURNO_PAGOS).getValues()
    .filter(r => r[0] instanceof Date && String(r[1]).trim()).map(r => ({
      fecha: ymd(r[0]), socio_id: String(r[7] || idDe(r[1])).trim(), periodo: String(r[2]), monto: Number(r[3]) || 0, metodo: String(r[4]),
      recibio: String(r[5]), notas: String(r[6]), lista: Number(r[9]) || 0, inicia: ymd(r[10]), vence: ymd(r[11]), turno: String(r[12] || '')
    }));
  // Asistencias (todas las pestañas de meses) + horas del registro
  const horas = {};
  const reg = ss.getSheetByName(ADM.HOJA_REGISTRO);
  if (reg && reg.getLastRow() >= 2) reg.getRange(2, 1, reg.getLastRow() - 1, 5).getValues().forEach(r => {
    if (r[0] instanceof Date) horas[ymd(r[0]) + '|' + String(r[2]).trim()] = { hora: hm(r[1]), registro: String(r[4]) };
  });
  out.asistencias = [];
  ss.getSheets().filter(h => /^Asistencias/.test(h.getName())).forEach(h => {
    const fechas = h.getRange(7, 4, 1, 31).getValues()[0];
    const ids = h.getRange(8, 1, 500, 1).getDisplayValues();
    const grid = h.getRange(8, 4, 500, 31).getValues();
    for (let i = 0; i < 500; i++) {
      const id = String(ids[i][0]).trim(); if (!id) continue;
      for (let d = 0; d < 31; d++) {
        const v = grid[i][d];
        if (v === '' || v === null || !(fechas[d] instanceof Date)) continue;
        const f = ymd(fechas[d]), k = horas[f + '|' + id];
        out.asistencias.push({ fecha: f, socio_id: id, hora: k ? k.hora : (typeof v === 'number' ? hm(v) : ''), registro: k ? k.registro : 'Capturada a mano' });
      }
    }
  });
  // Inventario y ventas
  out.productos = ss.getSheetByName('Inventario').getRange(ADM.PRIMERA_FILA_INV, 1, ADM.ULTIMA_FILA_INV - ADM.PRIMERA_FILA_INV + 1, 6).getValues()
    .filter(r => String(r[0]).trim()).map(r => ({ nombre: String(r[0]).trim(), precio: Number(r[1]) || 0, recibidas: Number(r[2]) || 0, minimo: r[5] === '' ? null : Number(r[5]) }));
  const vt = ss.getSheetByName('Ventas');
  const vl = adm_ultimaFila_(vt, ADM.PRIMERA_FILA_VENTAS, ADM.ULTIMA_FILA_VENTAS, [1, 4]);
  out.ventas = vl < ADM.PRIMERA_FILA_VENTAS ? [] : vt.getRange(ADM.PRIMERA_FILA_VENTAS, 1, vl - ADM.PRIMERA_FILA_VENTAS + 1, ADM.COL_TURNO_VENTAS).getValues()
    .filter(r => r[0] instanceof Date && String(r[2]).trim()).map(r => ({
      fecha: ymd(r[0]), hora: '', socio_id: idDe(r[1]), producto: String(r[2]).trim(), cantidad: Number(r[3]) || 0, precio: Number(r[4]) || 0,
      total: Number(r[5]) || 0, metodo: String(r[6]), notas: String(r[7]), turno: String(r[10] || '')
    }));
  // Caja
  const tu = ss.getSheetByName(ADM.HOJA_TURNOS);
  out.turnos = !tu || tu.getLastRow() < 2 ? [] : tu.getRange(2, 1, tu.getLastRow() - 1, ADM_TURNO_COLS.length).getValues().filter(r => String(r[0]).trim()).map(r => ({
    id: String(r[0]), persona: String(r[1]), fecha: ymd(r[2]), hora: hm(r[3]), dejo: Number(r[4]) || 0, inicial: Number(r[5]) || 0, dif_apertura: Number(r[6]) || 0,
    cobros: Number(r[7]) || 0, ventas: Number(r[8]) || 0, salidas: Number(r[9]) || 0, esperado: Number(r[10]) || 0, contado: Number(r[11]) || 0,
    diferencia: Number(r[12]) || 0, motivo: String(r[13]), transferencias: Number(r[14]) || 0, tarjeta: Number(r[15]) || 0,
    fecha_cierre: ymd(r[16]), hora_cierre: r[17] === '' ? '' : hm(r[17]), estado: String(r[18])
  }));
  const sa = ss.getSheetByName(ADM.HOJA_SALIDAS);
  out.salidas = !sa || sa.getLastRow() < 2 ? [] : sa.getRange(2, 1, sa.getLastRow() - 1, ADM_SALIDA_COLS.length).getValues().filter(r => r[0] instanceof Date).map(r => ({
    fecha: ymd(r[0]), hora: hm(r[1]), categoria: String(r[2]), concepto: String(r[3]), pagado_a: String(r[4]), monto: Number(r[5]) || 0,
    origen: String(r[6]), prestamo: String(r[7]), turno: String(r[8]), registro: String(r[9]), notas: String(r[10])
  }));
  out.prestamos = adm_prestamos_(ss).map(p => ({ nombre: p.nombre, monto: p.monto, previo: p.previo, abono: p.abono, notas: p.notas }));
  // Configuración y tarifas
  const cf = ss.getSheetByName('Configuración'), t = ss.getSheetByName('Tarifas').getRange('A3:G6').getValues();
  const tarifas = {};
  for (let i = 1; i < t.length; i++) if (t[i][0]) { tarifas[t[i][0]] = {}; for (let j = 1; j < 7; j++) tarifas[t[i][0]][t[0][j]] = Number(t[i][j]) || 0; }
  const meses = {}; cf.getRange('A16:B21').getValues().forEach(r => { if (r[0]) meses[r[0]] = Number(r[1]) || 0; });
  out.config = {
    gym: cf.getRange('B4').getDisplayValue(), lada: cf.getRange('B5').getDisplayValue(), dias_anticipacion: cf.getRange('B6').getDisplayValue(),
    tolerancia: cf.getRange('B7').getDisplayValue(), msg_recordatorio: cf.getRange('B8').getValue(), msg_vencido: cf.getRange('B9').getValue(),
    msg_visita: cf.getRange('B26').getValue(), msg_nuevo: cf.getRange('B27').getValue(), hora_gracias: cf.getRange('B28').getDisplayValue(),
    personal: cf.getRange('B31').getDisplayValue() || ADM.PERSONAL_DEFAULT, aviso_minimo: String(ss.getSheetByName('Inventario').getRange('B3').getValue() || 5),
    umbral_asistencia: String(ss.getSheetByName('Asistencias').getRange('C4').getValue() || 7), tarifas: tarifas, meses_periodo: meses
  };
  return out;
}

/* ---------- Configuración única: asistencia con «A» ----------
 * Ejecutar UNA vez desde el editor (Ejecutar → adm_configurarAsistenciaA):
 *  - Las fórmulas de «Asistencias» cuentan la «A» (y también horas capturadas antes).
 *  - «Resumen asistencia» toma las franjas horarias del «Registro de entradas».
 *  - Las horas ya capturadas este mes pasan al Registro y la celda queda con «A».
 */
function adm_configurarAsistenciaA() {
  const ss = adm_ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName('Asistencias');
  const reg = adm_hojaRegistro_(ss);
  const R = "'" + ADM.HOJA_REGISTRO + "'";

  // 1) Fórmulas de la cuadrícula
  const cols = [];
  for (let c = 4; c <= 34; c++) cols.push(c); // D..AH
  cols.forEach(c => {
    const L = sh.getRange(1, c).getA1Notation().replace(/\d+/g, '');
    sh.getRange(5, c).setFormula('=IF(' + L + '7="","",COUNTA(' + L + '8:' + L + '507))');
  });
  const fAI = [], fAJ = [];
  for (let r = 8; r <= 507; r++) {
    fAI.push(['=IF(A' + r + '="","",COUNTA(D' + r + ':AH' + r + '))']);
    fAJ.push(['=IF(A' + r + '="","",IF(AI' + r + '=0,"",MAXIFS($D$7:$AH$7,D' + r + ':AH' + r + ',"<>")))']);
  }
  sh.getRange('AI8:AI507').setFormulas(fAI);
  sh.getRange('AJ8:AJ507').setFormulas(fAJ);
  sh.getRange('D8:AH507').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=OR(D8="",UPPER(D8)="A",ISNUMBER(D8))').setAllowInvalid(false)
    .setHelpText('Escribe A para marcar la entrada (la app la pone sola).').build());
  sh.getRange('A2').setValue('La app marca con «A» la entrada del socio en el día; la hora queda en «' + ADM.HOJA_REGISTRO + '». A mano también puedes escribir A.');

  // 2) Pasar al Registro las horas ya capturadas en este mes
  const fechas = sh.getRange(7, 4, 1, 31).getValues()[0];
  const ids = sh.getRange(8, 1, 500, 2).getDisplayValues();
  const grid = sh.getRange(8, 4, 500, 31);
  const vals = grid.getValues(), disp = grid.getDisplayValues();
  const filas = [];
  let migradas = 0;
  for (let d = 0; d < 31; d++) {
    if (!(fechas[d] instanceof Date)) continue;
    for (let i = 0; i < 500; i++) {
      const v = vals[i][d];
      if (v === '' || v === null) continue;
      if (typeof v === 'number' || v instanceof Date) {
        const m = String(disp[i][d]).match(/^(\d{1,2}):(\d{2})/);
        if (m) filas.push([fechas[d], (Number(m[1]) * 60 + Number(m[2])) / 1440, ids[i][0], ids[i][1], 'Capturada a mano']);
        vals[i][d] = 'A'; migradas++;
      }
    }
  }
  filas.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (filas.length) {
    const ini = reg.getLastRow() + 1;
    reg.getRange(ini, 1, filas.length, 5).setValues(filas);
    reg.getRange(ini, 1, filas.length, 1).setNumberFormat('dd/mm/yyyy');
    reg.getRange(ini, 2, filas.length, 1).setNumberFormat('H:mm');
  }
  grid.setValues(vals);

  // 3) Franjas horarias del Resumen desde el Registro (solo el mes de «Asistencias»)
  const rs = ss.getSheetByName('Resumen asistencia');
  let franjas = 0;
  if (rs) {
    const mesIni = 'DATE(YEAR(Asistencias!$C$3),MONTH(Asistencias!$C$3),1)';
    const mesFin = 'EOMONTH(Asistencias!$C$3,0)';
    for (let r = 14; r <= 40; r++) {
      const x = rs.getRange(r, 2).getFormula();
      const m = x.match(/TIME\((\d+),0,0\).*TIME\((\d+),0,0\)/);
      if (!m || x.indexOf('Asistencias!$D$8') < 0) continue;
      rs.getRange(r, 2).setFormula('=COUNTIFS(' + R + '!$B:$B,">="&TIME(' + m[1] + ',0,0),' + R + '!$B:$B,"<"&TIME(' + m[2] + ',0,0),' +
        R + '!$A:$A,">="&' + mesIni + ',' + R + '!$A:$A,"<="&' + mesFin + ')');
      franjas++;
    }
  }
  SpreadsheetApp.flush();
  console.log('Horas pasadas al Registro: ' + filas.length + ' · celdas cambiadas a A: ' + migradas + ' · franjas actualizadas: ' + franjas);
}

/* Prueba manual desde el editor: Ejecutar → adm_probar */
function adm_probar() {
  const d = adm_datos_('dueno');
  console.log('Socios: %s · Pagos: %s · Ventas: %s · Productos: %s · Mes asistencia: %s',
    d.socios.length, d.pagos.length, d.ventas.length, d.productos.length, d.asistencia.mes);
}

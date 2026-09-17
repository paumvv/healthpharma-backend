import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const sinPassword = ({ password, ...resto }) => resto;
const generarFolio = () => `TK-${Date.now().toString(36).toUpperCase().slice(-6)}`;

// Reconstruye tickets con su arreglo de items (JOIN ticket_detalle + medicamentos)
const cargarItemsDeTickets = async (tickets) => {
  if (tickets.length === 0) return tickets;
  const folios = tickets.map((t) => t.folio);
  const [filas] = await pool.query(
    `SELECT d.ticket_folio, d.medicamento_id AS id, d.cantidad AS cantidadSeleccionada, d.precio_unitario AS precio,
            m.nombre, m.formula, m.categoria, m.requiere_receta AS requiereReceta
     FROM ticket_detalle d
     JOIN medicamentos m ON m.id = d.medicamento_id
     WHERE d.ticket_folio IN (?)`,
    [folios]
  );
  const itemsPorFolio = {};
  filas.forEach((f) => {
    const { ticket_folio, ...item } = f;
    item.requiereReceta = !!item.requiereReceta;
    item.precio = Number(item.precio);
    (itemsPorFolio[ticket_folio] ??= []).push(item);
  });
  return tickets.map((t) => ({ ...t, items: itemsPorFolio[t.folio] ?? [] }));
};

// ---------------------------------------------------------------- Auth ----
app.post('/api/auth/login', async (req, res) => {
  const { correo, password } = req.body;
  const [filas] = await pool.query(
    'SELECT * FROM usuarios WHERE LOWER(correo) = LOWER(?) AND password = ? LIMIT 1',
    [correo?.trim(), password]
  );
  if (filas.length === 0) return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos.' });
  res.json({ ok: true, usuario: sinPassword(filas[0]) });
});

app.post('/api/auth/register', async (req, res) => {
  const { nombre, telefono, correo, password, fechaNacimiento, apellidoPaterno, apellidoMaterno } = req.body;
  const correoNorm = correo?.trim().toLowerCase();
  const [existentes] = await pool.query('SELECT id FROM usuarios WHERE LOWER(correo) = ?', [correoNorm]);
  if (existentes.length > 0) return res.status(409).json({ ok: false, error: 'Ya existe una cuenta registrada con ese correo.' });

  const id = `u-${Date.now()}`;
  await pool.query(
    'INSERT INTO usuarios (id, nombre, correo, password, telefono, rol) VALUES (?, ?, ?, ?, ?, ?)',
    [id, nombre, correoNorm, password, telefono, 'cliente']
  );
  res.status(201).json({ ok: true, usuario: { id, nombre, correo: correoNorm, telefono, rol: 'cliente', foto: '' } });
});

app.post('/api/auth/verificar-recuperacion', async (req, res) => {
  const { correo, telefono } = req.body;
  const [filas] = await pool.query(
    'SELECT id FROM usuarios WHERE LOWER(correo) = LOWER(?) AND telefono = ? LIMIT 1',
    [correo?.trim(), telefono?.trim()]
  );
  if (filas.length === 0) return res.status(404).json({ ok: false, error: 'No encontramos una cuenta con ese correo y teléfono.' });
  res.json({ ok: true });
});

app.post('/api/auth/recuperar-password', async (req, res) => {
  const { correo, telefono, passwordNueva } = req.body;
  const [resultado] = await pool.query(
    'UPDATE usuarios SET password = ? WHERE LOWER(correo) = LOWER(?) AND telefono = ?',
    [passwordNueva, correo?.trim(), telefono?.trim()]
  );
  if (resultado.affectedRows === 0) return res.status(404).json({ ok: false, error: 'No encontramos una cuenta con ese correo y teléfono.' });
  res.json({ ok: true });
});

// ------------------------------------------------------------ Usuarios ----
app.put('/api/usuarios/:id', async (req, res) => {
  const { nombre, telefono, foto } = req.body;
  const campos = [];
  const valores = [];
  if (nombre !== undefined) { campos.push('nombre = ?'); valores.push(nombre); }
  if (telefono !== undefined) { campos.push('telefono = ?'); valores.push(telefono); }
  if (foto !== undefined) { campos.push('foto = ?'); valores.push(foto); }
  if (campos.length === 0) return res.json({ ok: true });

  valores.push(req.params.id);
  await pool.query(`UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`, valores);
  const [filas] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [req.params.id]);
  res.json({ ok: true, usuario: sinPassword(filas[0]) });
});

app.put('/api/usuarios/:id/password', async (req, res) => {
  const { passwordActual, passwordNueva } = req.body;
  const [filas] = await pool.query('SELECT password FROM usuarios WHERE id = ?', [req.params.id]);
  if (filas.length === 0 || filas[0].password !== passwordActual) {
    return res.status(401).json({ ok: false, error: 'La contraseña actual no es correcta.' });
  }
  await pool.query('UPDATE usuarios SET password = ? WHERE id = ?', [passwordNueva, req.params.id]);
  res.json({ ok: true });
});

// --------------------------------------------------------- Medicamentos ----
// "disponible" = cantidad real menos lo reservado por tickets pendientes de recolección
// (que aún no se descuentan del inventario hasta que se confirma la entrega). Se calcula
// aquí en el servidor para no tener que exponerle a cada cliente los tickets de los demás.
app.get('/api/medicamentos', async (_req, res) => {
  const [filas] = await pool.query(
    `SELECT m.*,
            GREATEST(0, m.cantidad - COALESCE(r.reservado, 0)) AS disponible
     FROM medicamentos m
     LEFT JOIN (
       SELECT d.medicamento_id, SUM(d.cantidad) AS reservado
       FROM ticket_detalle d
       JOIN tickets t ON t.folio = d.ticket_folio
       WHERE t.estado = 'Pendiente de Recolección'
       GROUP BY d.medicamento_id
     ) r ON r.medicamento_id = m.id
     ORDER BY m.nombre`
  );
  res.json(filas.map((p) => {
    const { requiere_receta, fecha_caducidad, codigo_barras, ...resto } = p;
    return {
      ...resto,
      requiereReceta: !!requiere_receta,
      fechaCaducidad: fecha_caducidad ? new Date(fecha_caducidad).toISOString().slice(0, 10) : null,
      codigoBarras: codigo_barras,
      precio: Number(p.precio),
      disponible: Number(p.disponible)
    };
  }));
});

app.post('/api/medicamentos', async (req, res) => {
  const p = req.body;
  await pool.query(
    `INSERT INTO medicamentos (id, nombre, formula, categoria, precio, cantidad, requiere_receta, presentacion, dosis, descripcion, contraindicaciones, fecha_caducidad, codigo_barras, imagen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nombre=VALUES(nombre), formula=VALUES(formula), categoria=VALUES(categoria), precio=VALUES(precio),
       cantidad=VALUES(cantidad), requiere_receta=VALUES(requiere_receta), presentacion=VALUES(presentacion),
       dosis=VALUES(dosis), descripcion=VALUES(descripcion), contraindicaciones=VALUES(contraindicaciones),
       fecha_caducidad=VALUES(fecha_caducidad), codigo_barras=VALUES(codigo_barras), imagen=VALUES(imagen)`,
    [p.id, p.nombre, p.formula || null, p.categoria || null, p.precio || 0, p.cantidad || 0, !!p.requiereReceta,
     p.presentacion || null, p.dosis || null, p.descripcion || null, p.contraindicaciones || null,
     p.fechaCaducidad || null, p.codigoBarras || null, p.imagen || null]
  );
  res.json({ ok: true, producto: p });
});

app.delete('/api/medicamentos/:id', async (req, res) => {
  await pool.query('DELETE FROM medicamentos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// -------------------------------------------------------------- Tickets ----
app.get('/api/tickets', async (req, res) => {
  const { correo } = req.query;
  const [filas] = correo
    ? await pool.query('SELECT * FROM tickets WHERE correo = ? ORDER BY fecha DESC', [correo])
    : await pool.query('SELECT * FROM tickets ORDER BY fecha DESC');
  res.json(await cargarItemsDeTickets(filas.map((t) => ({ ...t, total: Number(t.total) }))));
});

app.post('/api/tickets', async (req, res) => {
  const { usuario_id, cliente, correo, telefono, items } = req.body;
  const total = items.reduce((acc, i) => acc + i.precio * i.cantidadSeleccionada, 0);
  const folio = generarFolio();

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    await conexion.query(
      'INSERT INTO tickets (folio, usuario_id, cliente, correo, telefono, total, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [folio, usuario_id, cliente, correo, telefono, total, 'Pendiente de Recolección']
    );
    for (const item of items) {
      await conexion.query(
        'INSERT INTO ticket_detalle (ticket_folio, medicamento_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
        [folio, item.id, item.cantidadSeleccionada, item.precio]
      );
    }
    await conexion.commit();
  } catch (error) {
    await conexion.rollback();
    conexion.release();
    return res.status(500).json({ ok: false, error: 'No se pudo generar el ticket.' });
  }
  conexion.release();

  const [[ticketCreado]] = await pool.query('SELECT * FROM tickets WHERE folio = ?', [folio]);
  const [ticketConItems] = await cargarItemsDeTickets([{ ...ticketCreado, total: Number(ticketCreado.total) }]);
  res.status(201).json({ ok: true, ticket: ticketConItems });
});

app.put('/api/tickets/:folio/cancelar', async (req, res) => {
  await pool.query("UPDATE tickets SET estado = 'Cancelado' WHERE folio = ?", [req.params.folio]);
  res.json({ ok: true });
});

app.put('/api/tickets/:folio/confirmar-entrega', async (req, res) => {
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [[ticket]] = await conexion.query('SELECT * FROM tickets WHERE folio = ?', [req.params.folio]);
    if (!ticket) throw new Error('Ticket no encontrado');
    const [detalle] = await conexion.query('SELECT * FROM ticket_detalle WHERE ticket_folio = ?', [req.params.folio]);

    for (const item of detalle) {
      await conexion.query(
        'UPDATE medicamentos SET cantidad = GREATEST(0, cantidad - ?) WHERE id = ?',
        [item.cantidad, item.medicamento_id]
      );
    }
    await conexion.query("UPDATE tickets SET estado = 'Entregado' WHERE folio = ?", [req.params.folio]);
    await conexion.query(
      'INSERT INTO ventas (id, ticket_folio, total, origen) VALUES (?, ?, ?, ?)',
      [ticket.folio, ticket.folio, ticket.total, 'Ticket en línea']
    );
    await conexion.commit();
  } catch (error) {
    await conexion.rollback();
    conexion.release();
    return res.status(500).json({ ok: false, error: 'No se pudo confirmar la entrega.' });
  }
  conexion.release();
  res.json({ ok: true });
});

// --------------------------------------------------------------- Ventas ----
// Venta directa en mostrador (POS): sin ticket previo, descuenta inventario de inmediato.
app.post('/api/ventas', async (req, res) => {
  const { items, recetaVerificada } = req.body;
  const total = items.reduce((acc, i) => acc + i.precio * i.cantidadSeleccionada, 0);
  const id = `POS-${Date.now().toString(36).toUpperCase().slice(-6)}`;

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    for (const item of items) {
      const [[producto]] = await conexion.query('SELECT cantidad, fecha_caducidad FROM medicamentos WHERE id = ? FOR UPDATE', [item.id]);
      if (!producto) throw new Error('Producto no encontrado');
      if (new Date(producto.fecha_caducidad) < new Date()) throw new Error(`${item.nombre ?? item.id} está caducado`);
      if (producto.cantidad < item.cantidadSeleccionada) throw new Error(`Sin existencias suficientes de ${item.nombre ?? item.id}`);
      await conexion.query('UPDATE medicamentos SET cantidad = cantidad - ? WHERE id = ?', [item.cantidadSeleccionada, item.id]);
    }
    await conexion.query(
      'INSERT INTO ventas (id, ticket_folio, total, origen, receta_verificada) VALUES (?, NULL, ?, ?, ?)',
      [id, total, 'Punto de venta', !!recetaVerificada]
    );
    // Reutilizamos ticket_detalle para guardar el detalle de la venta (ticket_folio = id de la venta)
    await conexion.query('INSERT INTO tickets (folio, total, estado) VALUES (?, ?, ?)', [id, total, 'Entregado']);
    for (const item of items) {
      await conexion.query(
        'INSERT INTO ticket_detalle (ticket_folio, medicamento_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
        [id, item.id, item.cantidadSeleccionada, item.precio]
      );
    }
    await conexion.query('UPDATE ventas SET ticket_folio = ? WHERE id = ?', [id, id]);
    await conexion.commit();
  } catch (error) {
    await conexion.rollback();
    conexion.release();
    return res.status(400).json({ ok: false, error: error.message || 'No se pudo procesar la venta.' });
  }
  conexion.release();
  res.status(201).json({ ok: true, id });
});

app.get('/api/ventas', async (_req, res) => {
  const [ventas] = await pool.query('SELECT * FROM ventas ORDER BY fecha DESC');
  const conItems = await Promise.all(
    ventas.map(async (v) => {
      const [tickets] = await cargarItemsDeTickets([{ folio: v.ticket_folio }]);
      return { ...v, total: Number(v.total), items: tickets?.items ?? [] };
    })
  );
  res.json(conItems);
});

// ------------------------------------------------- Auto-cancelación 48h ----
// Antes vivía en el navegador (dependía de tener la app abierta); ahora corre en el
// servidor real, así que aplica sin importar si algún cliente tiene la app abierta.
const HORAS_LIMITE_RECOLECCION = 48;
const cancelarTicketsVencidos = async () => {
  try {
    await pool.query(
      `UPDATE tickets
       SET estado = 'Cancelado'
       WHERE estado = 'Pendiente de Recolección'
         AND fecha <= (NOW() - INTERVAL ? HOUR)`,
      [HORAS_LIMITE_RECOLECCION]
    );
  } catch (error) {
    console.error('Error al cancelar tickets vencidos:', error.message);
  }
};
cancelarTicketsVencidos();
setInterval(cancelarTicketsVencidos, 15 * 60 * 1000);

const PUERTO = process.env.PORT || 3000;
app.listen(PUERTO, () => console.log(`HealthPharma API escuchando en el puerto ${PUERTO}`));

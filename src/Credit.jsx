/** Author credit, pinned bottom-left on every screen. */
const CONTACT = {
  name: 'Brahmansh Atrey',
  phone: '', // e.g. '+91 98765 43210' — shown once filled in
  email: 'brahmansh56@gmail.com',
};

export default function Credit() {
  return (
    <footer className="credit">
      <span className="credit-name">{CONTACT.name}</span>
      {CONTACT.phone && <a href={`tel:${CONTACT.phone.replace(/[^+\d]/g, '')}`}>{CONTACT.phone}</a>}
      <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
    </footer>
  );
}

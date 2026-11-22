-- SENTINELLE VIVANT : suivi GPS des balises de démonstration.
-- Le téléphone transmet sa position RELATIVE au repère : mètres vers l'est et vers le nord, calculés sur le téléphone à partir
-- de son GPS. Cela donne une vraie trajectoire (distance et direction) sans stocker de coordonnées géographiques :
-- on sait où est la balise par rapport au repère, pas où est le repère sur la Terre.
ALTER TABLE device_readings ADD COLUMN east_m real;
ALTER TABLE device_readings ADD COLUMN north_m real;
